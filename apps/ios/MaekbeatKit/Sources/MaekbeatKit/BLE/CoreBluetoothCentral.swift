#if canImport(CoreBluetooth)
import CoreBluetooth
import Foundation

/*
 * The adapter, and the only file in this package that imports CoreBluetooth.
 *
 * It is deliberately stupid. Every delegate callback does one thing: turn a
 * framework event into a `LinkEvent` and hand it over. No retries, no
 * timeouts, no state — `BLELinkMachine` owns all of that and is exhaustively
 * tested, because none of what is below this line can run in the gate.
 *
 * What CI does reach, on a simulator with no radio at all:
 *   - constructing the manager and receiving `.unsupported`,
 *   - the two pure translations below.
 * What needs a physical device and a peripheral: everything from `didConnect`
 * onward, and state restoration. apps/ios/README.md lists it line by line.
 *
 * One thing is neither: CoreBluetooth raises at construction when a restore
 * identifier is set without the bluetooth-central background mode. That was
 * observed while writing this commit, but no test in the repository performs
 * the raise — an ObjC exception is not catchable from Swift — so what CI checks
 * is the configuration that avoids it, in SourceDisciplineTests.
 */
@MainActor
public final class CoreBluetoothCentral: NSObject, PeripheralPort {
    /// Passed to CoreBluetooth so iOS can relaunch the app into a restored
    /// central. It is only legal with the bluetooth-central background mode
    /// declared; without it CoreBluetooth raises at construction, which is why
    /// `SourceDisciplineTests` asserts the Info.plist keys from the project
    /// file — that assertion is the guard, not a test of the raise itself.
    public nonisolated static let restoreIdentifier = "dev.maekbeat.central"

    private let emit: (LinkEvent) -> Void
    private let deliver: (Data, String) -> Void
    private let restoreIdentifier: String?

    private var central: CBCentralManager?
    private var peripheral: CBPeripheral?
    private var vitals: CBCharacteristic?

    public init(
        restoreIdentifier: String? = CoreBluetoothCentral.restoreIdentifier,
        emit: @escaping (LinkEvent) -> Void,
        deliver: @escaping (Data, String) -> Void
    ) {
        self.restoreIdentifier = restoreIdentifier
        self.emit = emit
        self.deliver = deliver
        super.init()
    }

    /// Creates the manager. Separate from `init` so a caller can construct the
    /// adapter without powering anything on, and so the throwing case above is
    /// reachable from a test at a point it controls.
    public func activate() {
        var options: [String: Any] = [:]
        if let restoreIdentifier {
            options[CBCentralManagerOptionRestoreIdentifierKey] = restoreIdentifier
        }
        central = CBCentralManager(delegate: self, queue: .main, options: options)
    }

    // MARK: - Pure translations (these do run in CI)

    /// The radio's state as the machine's vocabulary. `.poweredOn` is the only
    /// one that means "go"; everything else is a reason to say why not.
    public static func event(for state: CBManagerState) -> LinkEvent {
        switch state {
        case .poweredOn: return .radioReady
        case .poweredOff: return .radioUnavailable(.poweredOff)
        case .unauthorized: return .radioUnavailable(.unauthorized)
        case .unsupported: return .radioUnavailable(.unsupported)
        case .resetting: return .radioUnavailable(.resetting)
        case .unknown: return .radioUnavailable(.unknown)
        @unknown default: return .radioUnavailable(.unknown)
        }
    }

    public static var serviceUUID: CBUUID { CBUUID(string: GattProfile.serviceUUID) }
    public static var vitalsUUID: CBUUID { CBUUID(string: GattProfile.vitalsCharacteristicUUID) }

    // MARK: - PeripheralPort

    public func scanAndConnect() {
        central?.scanForPeripherals(withServices: [Self.serviceUUID])
    }

    public func discoverServices() {
        peripheral?.discoverServices([Self.serviceUUID])
    }

    public func enableNotifications() {
        guard let peripheral, let vitals else { return }
        peripheral.setNotifyValue(true, for: vitals)
    }

    public func cancelConnection() {
        central?.stopScan()
        if let peripheral { central?.cancelPeripheralConnection(peripheral) }
        self.peripheral = nil
        vitals = nil
    }
}

// MARK: - Delegates

// `@preconcurrency` because the delegate requirements are nonisolated and this
// class is not. The manager is constructed with `queue: .main`, so every
// callback below genuinely arrives on the main actor; the attribute records
// that the compiler cannot see the guarantee, not that there isn't one.
extension CoreBluetoothCentral: @preconcurrency CBCentralManagerDelegate {
    public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        emit(Self.event(for: central.state))
    }

    /// Required whenever a restore identifier is set; CoreBluetooth raises at
    /// construction if it is missing. Restoration hands back the peripherals
    /// iOS kept for us, and the machine is told the link is up again only after
    /// the usual discovery path re-runs.
    public func centralManager(
        _ central: CBCentralManager,
        willRestoreState state: [String: Any]
    ) {
        let restored = state[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral]
        peripheral = restored?.first
        peripheral?.delegate = self
    }

    public func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        central.stopScan()
        self.peripheral = peripheral
        peripheral.delegate = self
        central.connect(peripheral)
    }

    public func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        emit(.peripheralConnected)
    }

    public func centralManager(
        _ central: CBCentralManager,
        didFailToConnect peripheral: CBPeripheral,
        error: Error?
    ) {
        emit(.linkLost)
    }

    public func centralManager(
        _ central: CBCentralManager,
        didDisconnectPeripheral peripheral: CBPeripheral,
        error: Error?
    ) {
        emit(.linkLost)
    }
}

extension CoreBluetoothCentral: @preconcurrency CBPeripheralDelegate {
    public func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let service = peripheral.services?.first(where: { $0.uuid == Self.serviceUUID }) else {
            return emit(.linkLost)
        }
        peripheral.discoverCharacteristics([Self.vitalsUUID], for: service)
    }

    public func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        vitals = service.characteristics?.first { $0.uuid == Self.vitalsUUID }
        emit(vitals == nil ? .linkLost : .servicesResolved)
    }

    public func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateNotificationStateFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        emit(characteristic.isNotifying ? .notificationsEnabled : .linkLost)
    }

    public func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard let payload = characteristic.value else { return }
        deliver(payload, peripheral.identifier.uuidString)
    }
}
#endif
