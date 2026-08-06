#if canImport(CoreBluetooth)
import CoreBluetooth
import XCTest
@testable import MaekbeatKit

/*
 * The slice of the CoreBluetooth adapter that CI can actually execute.
 *
 * An iOS Simulator has no Bluetooth stack, so nothing here connects to
 * anything. What it does have is a real `CBCentralManager` that initialises and
 * reports `.unsupported`, and that is enough to prove three things without
 * hardware: the identifiers are usable by the framework, the state translation
 * is right for every case the framework defines, and the adapter reaches the
 * machine when the radio answers.
 *
 * Everything from `didConnect` onward needs a device and a peripheral. It is
 * listed line by line in apps/ios/README.md rather than left implied, and it is
 * the reason the adapter holds no logic worth testing.
 */
@MainActor
final class CoreBluetoothAdapterTests: XCTestCase {
    private var central: CoreBluetoothCentral?

    override func tearDown() {
        central = nil
        super.tearDown()
    }

    // MARK: - Translation (pure, every case)

    func testEveryRadioStateTranslatesToExactlyOneLinkEvent() {
        let expected: [CBManagerState: LinkEvent] = [
            .poweredOn: .radioReady,
            .poweredOff: .radioUnavailable(.poweredOff),
            .unauthorized: .radioUnavailable(.unauthorized),
            .unsupported: .radioUnavailable(.unsupported),
            .resetting: .radioUnavailable(.resetting),
            .unknown: .radioUnavailable(.unknown)
        ]
        for (state, event) in expected {
            XCTAssertEqual(CoreBluetoothCentral.event(for: state), event, "\(state.rawValue)")
        }
        XCTAssertEqual(expected.count, 6, "CBManagerState gained a case")
    }

    /// Only `.poweredOn` means go. A translation that let any other state
    /// through would have the machine scanning on a radio that is off.
    func testOnlyPoweredOnIsTreatedAsReady() {
        let all: [CBManagerState] = [
            .poweredOn, .poweredOff, .unauthorized, .unsupported, .resetting, .unknown
        ]
        let ready = all.filter { CoreBluetoothCentral.event(for: $0) == .radioReady }
        XCTAssertEqual(ready, [.poweredOn])
    }

    /// `CBUUID(string:)` raises on a malformed identifier, so this is a real
    /// check that the profile's constants are usable by the framework and not
    /// merely well-formed to a human eye.
    func testTheProfileIdentifiersAreUsableAsCoreBluetoothUUIDs() {
        XCTAssertEqual(
            CoreBluetoothCentral.serviceUUID.uuidString.uppercased(),
            GattProfile.serviceUUID.uppercased()
        )
        XCTAssertEqual(
            CoreBluetoothCentral.vitalsUUID.uuidString.uppercased(),
            GattProfile.vitalsCharacteristicUUID.uppercased()
        )
        XCTAssertNotEqual(CoreBluetoothCentral.serviceUUID, CoreBluetoothCentral.vitalsUUID)
    }

    // MARK: - A real manager, on a machine with no radio

    /// Constructed without a restore identifier, because the test bundle
    /// declares no background mode and CoreBluetooth raises on restoration
    /// without one — the finding apps/ios/README.md records, and the reason the
    /// app target's Info.plist keys are asserted in SourceDisciplineTests.
    func testTheAdapterReportsTheRadioStateThroughToTheMachine() {
        var events: [LinkEvent] = []
        let reported = expectation(description: "the radio reported its state")
        let adapter = CoreBluetoothCentral(
            restoreIdentifier: nil,
            emit: { event in
                events.append(event)
                reported.fulfill()
            },
            deliver: { _, _ in XCTFail("no peripheral can deliver anything here") }
        )
        central = adapter

        adapter.activate()
        wait(for: [reported], timeout: 10)

        #if targetEnvironment(simulator)
        XCTAssertEqual(
            events.first,
            .radioUnavailable(.unsupported),
            "a simulator has no BLE radio; this is the honest answer"
        )
        #else
        let known: [LinkEvent] = [
            .radioReady, .radioUnavailable(.poweredOff), .radioUnavailable(.unauthorized),
            .radioUnavailable(.resetting), .radioUnavailable(.unknown)
        ]
        XCTAssertTrue(known.contains(events[0]), "unexpected device radio state: \(events[0])")
        #endif
    }

    /// The end the machine cares about: an unusable radio parks the link with a
    /// reason on it rather than leaving a screen saying "connecting" forever.
    func testAnUnusableRadioParksTheDriverWithAReason() {
        let driver = BLEDriver(port: MockPeripheralPort(), schedule: { _, _ in {} })
        let reported = expectation(description: "the radio reported its state")
        let adapter = CoreBluetoothCentral(
            restoreIdentifier: nil,
            emit: { event in
                driver.handle(event)
                reported.fulfill()
            },
            deliver: { payload, id in driver.receive(payload: payload, from: id) }
        )
        central = adapter
        driver.start()

        adapter.activate()
        wait(for: [reported], timeout: 10)

        #if targetEnvironment(simulator)
        XCTAssertEqual(driver.phase, .disconnected)
        XCTAssertEqual(driver.machine.unavailable, .unsupported)
        XCTAssertTrue(driver.machine.wantsLink, "the app still wants a link")
        #endif
    }

    /// Every port call before `activate()` is a no-op rather than a crash. iOS
    /// can hand a restored central back before anything has been powered on.
    func testThePortCallsAreSafeBeforeTheManagerExists() {
        let adapter = CoreBluetoothCentral(
            restoreIdentifier: nil,
            emit: { _ in },
            deliver: { _, _ in }
        )
        central = adapter

        adapter.scanAndConnect()
        adapter.discoverServices()
        adapter.enableNotifications()
        adapter.cancelConnection()
    }
}
#endif
