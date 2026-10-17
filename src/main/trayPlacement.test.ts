import assert from "node:assert/strict";
import test from "node:test";
import { trayMenuPlacement, type TrayRectangle } from "./trayPlacement";

function overlaps(a: TrayRectangle, b: TrayRectangle) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
test("tray popup avoids taskbar and overflow icons on every display edge", () => {
  for (const work of [
    { x: 0, y: 0, width: 1707, height: 970 },
    { x: -1920, y: -200, width: 1920, height: 1040 },
    { x: 1200, y: -1080, width: 1280, height: 680 },
    { x: 0, y: 0, width: 640, height: 400 },
  ]) {
    const right = work.x + work.width, bottom = work.y + work.height;
    for (const anchor of [
      { x: right - 60, y: bottom + 4, width: 24, height: 24 },
      { x: right - 200, y: bottom - 150, width: 24, height: 24 },
      { x: work.x + 4, y: work.y + 4, width: 24, height: 24 },
      { x: work.x - 28, y: work.y + 100, width: 24, height: 24 },
      { x: right + 4, y: work.y + 100, width: 24, height: 24 },
      { x: work.x + 120, y: work.y - 28, width: 24, height: 24 },
    ]) {
      const menu = trayMenuPlacement(anchor, work);
      assert.ok(menu.x >= work.x && menu.y >= work.y);
      assert.ok(menu.x + menu.width <= right && menu.y + menu.height <= bottom);
      assert.ok(!overlaps(menu, anchor), JSON.stringify({ menu, anchor }));
      assert.ok(menu.width > 0 && menu.height > 0);
    }
  }
});
test("overflow popup never covers the clicked icon at any grid location", () => {
  const work = { x: 0, y: 0, width: 1280, height: 720 };
  for (let y = 16; y < 700; y += 29) for (let x = 16; x < 1260; x += 31) {
    const icon = { x, y, width: 20, height: 20 };
    assert.equal(overlaps(trayMenuPlacement(icon, work), icon), false);
  }
});
