// 탭을 놓은 지점이 순서 바꾸기인지 새 창으로 분리인지 판정한다. DOM·IPC를 모르는 순수 함수.

export type DropAction = "reorder" | "detach";

export interface DropPoint {
  x: number;
  y: number;
}

export interface BarRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * 창 가로 범위(0~windowWidth) 밖이거나 탭바에서 위·아래로 thresholdPx를 *넘어서면* 분리,
 * 그 밖(정확히 임계 포함)은 순서 바꾸기. 좌표는 모두 같은 뷰포트 기준이다.
 */
export function dropAction(point: DropPoint, bar: BarRect, windowWidth: number, thresholdPx: number): DropAction {
  if (point.x < 0 || point.x > windowWidth) return "detach";
  if (point.y < bar.top - thresholdPx || point.y > bar.bottom + thresholdPx) return "detach";
  return "reorder";
}
