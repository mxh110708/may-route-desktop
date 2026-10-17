import type { Rectangle, Tray } from "electron";

interface TrayActions {
  openMainWindow(): void;
  hideMenu(): void;
  showMenu(bounds: Rectangle): void;
}

export function bindWindowsTrayActivation(tray: Pick<Tray, "on">, actions: TrayActions) {
  tray.on("click", () => {
    actions.hideMenu();
    actions.openMainWindow();
  });
  tray.on("right-click", (_event, bounds) => actions.showMenu(bounds));
  // A Windows double-click already includes the primary click. Registering
  // another activation here would repeat the show/focus operation.
}
