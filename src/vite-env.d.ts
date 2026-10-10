/// <reference types="vite/client" />

interface Window {
  /** vendor/muya 패치(vendor/muya/PATCHES.md) — Muya가 로컬 이미지 경로를 asset protocol URL로 바꿀 때 부른다. */
  MUYA_LOCAL_IMAGE_URL?: (path: string) => string;
}
