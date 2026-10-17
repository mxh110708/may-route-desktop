export interface TrayRectangle { x: number; y: number; width: number; height: number }
export interface TrayMenuSize { width: number; height: number }
export const DEFAULT_TRAY_MENU_SIZE: TrayMenuSize = { width: 244, height: 330 };
const GAP = 8;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

// Electron screen/tray rectangles use DIPs. Do not multiply by display scale.
// Keep the entire window, including shadow padding, outside the triggering icon.
export function trayMenuPlacement(anchor: TrayRectangle, work: TrayRectangle, size: TrayMenuSize = DEFAULT_TRAY_MENU_SIZE): TrayRectangle {
  const icon = { x: anchor.x - (anchor.width ? 0 : 8), y: anchor.y - (anchor.height ? 0 : 8), width: anchor.width || 16, height: anchor.height || 16 };
  const right = work.x + work.width, bottom = work.y + work.height;
  const above = clamp(icon.y - GAP, work.y, bottom);
  const below = clamp(icon.y + icon.height + GAP, work.y, bottom);
  const left = clamp(icon.x - GAP, work.x, right);
  const after = clamp(icon.x + icon.width + GAP, work.x, right);
  const regions = [
    { side: "above", x: work.x, y: work.y, width: work.width, height: above - work.y },
    { side: "below", x: work.x, y: below, width: work.width, height: bottom - below },
    { side: "left", x: work.x, y: work.y, width: left - work.x, height: work.height },
    { side: "right", x: after, y: work.y, width: right - after, height: work.height },
  ];
  const sized = regions.map((region) => ({ ...region, width: Math.min(size.width, region.width), height: Math.min(size.height, region.height) }));
  const region = sized.reduce((best, next) => next.width * next.height > best.width * best.height ? next : best);
  const x = region.side === "left" ? left - region.width : region.side === "right" ? after :
    clamp(icon.x + icon.width - region.width, work.x, right - region.width);
  const y = region.side === "above" ? above - region.height : region.side === "below" ? below :
    clamp(icon.y + icon.height / 2 - region.height / 2, work.y, bottom - region.height);
  return { x: Math.round(x), y: Math.round(y), width: Math.max(1, Math.floor(region.width)), height: Math.max(1, Math.floor(region.height)) };
}
