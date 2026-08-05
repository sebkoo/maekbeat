import { StatusPanel } from "../components/StatusPanel";

export function NotFoundRoute() {
  return (
    <StatusPanel
      variant="empty"
      headingLevel={1}
      title="No such page"
      detail="The dashboard has two routes today: the device list at / and one device at /devices/:deviceId."
    />
  );
}
