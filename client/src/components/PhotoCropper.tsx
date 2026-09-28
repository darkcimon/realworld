import { useEffect, useRef, useState } from "react";

const BOX = 240; // 크롭 프레임 크기(css px, 정사각형 — 아바타는 CSS에서 원형으로 잘려 보이므로 정사각형으로만 잘라도 충분하다)
const OUTPUT = 512; // 저장용 출력 해상도

// 트위터/인스타그램 프로필 사진 설정과 같은 방식: 이미지를 프레임에 꽉 채운 채로
// 드래그해서 위치를 옮기고, 슬라이더로 확대해서 원하는 영역을 프레임 안에 맞춘다.
export function PhotoCropper({
  file,
  onCancel,
  onConfirm,
}: {
  file: File;
  onCancel: () => void;
  onConfirm: (dataUrl: string) => void;
}) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const imgRef = useRef<HTMLImageElement>(null);
  const dragState = useRef<{ startX: number; startY: number; startOffset: { x: number; y: number } } | null>(
    null
  );

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setImgUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function baseScale(w: number, h: number): number {
    // "cover" 방식: 짧은 변이 프레임을 꽉 채우도록(=프레임 안이 빈 공간 없이 이미지로 가득 차도록)
    return Math.max(BOX / w, BOX / h);
  }

  function clamp(next: { x: number; y: number }, scale: number, w: number, h: number) {
    const dispW = w * scale;
    const dispH = h * scale;
    const minX = Math.min(0, BOX - dispW);
    const minY = Math.min(0, BOX - dispH);
    return {
      x: Math.max(minX, Math.min(0, next.x)),
      y: Math.max(minY, Math.min(0, next.y)),
    };
  }

  function onImgLoad() {
    const el = imgRef.current;
    if (!el) return;
    const w = el.naturalWidth;
    const h = el.naturalHeight;
    setNaturalSize({ w, h });
    const scale = baseScale(w, h);
    // 처음엔 이미지 중앙이 프레임 중앙에 오게
    setOffset(clamp({ x: (BOX - w * scale) / 2, y: (BOX - h * scale) / 2 }, scale, w, h));
    setZoom(1);
  }

  function effectiveScale(): number {
    if (!naturalSize) return 1;
    return baseScale(naturalSize.w, naturalSize.h) * zoom;
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!naturalSize) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    dragState.current = { startX: e.clientX, startY: e.clientY, startOffset: offset };
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragState.current || !naturalSize) return;
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    const scale = effectiveScale();
    setOffset(
      clamp(
        { x: dragState.current.startOffset.x + dx, y: dragState.current.startOffset.y + dy },
        scale,
        naturalSize.w,
        naturalSize.h
      )
    );
  }
  function onPointerUp() {
    dragState.current = null;
  }

  function onZoomChange(next: number) {
    if (!naturalSize) return;
    setZoom(next);
    const scale = baseScale(naturalSize.w, naturalSize.h) * next;
    setOffset((prev) => clamp(prev, scale, naturalSize.w, naturalSize.h));
  }

  function confirm() {
    const el = imgRef.current;
    if (!el || !naturalSize) return;
    const scale = effectiveScale();
    // 프레임(BOX x BOX, 화면 좌표계)에 지금 보이는 영역을, 원본 이미지 픽셀 좌표로 역산한다.
    const sx = -offset.x / scale;
    const sy = -offset.y / scale;
    const sSize = BOX / scale;

    const canvas = document.createElement("canvas");
    canvas.width = OUTPUT;
    canvas.height = OUTPUT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(el, sx, sy, sSize, sSize, 0, 0, OUTPUT, OUTPUT);
    onConfirm(canvas.toDataURL("image/jpeg", 0.85));
  }

  return (
    <div className="cropper">
      <div
        className="cropper-box"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {imgUrl && (
          <img
            ref={imgRef}
            src={imgUrl}
            alt="자르기 대상"
            draggable={false}
            onLoad={onImgLoad}
            style={
              naturalSize
                ? {
                    width: naturalSize.w * effectiveScale(),
                    height: naturalSize.h * effectiveScale(),
                    left: offset.x,
                    top: offset.y,
                  }
                : { opacity: 0 }
            }
          />
        )}
      </div>
      <p className="hint">드래그해서 위치를 옮기고, 슬라이더로 확대해 원하는 부분을 맞춰주세요.</p>
      <div className="cropper-zoom">
        <span>🔍</span>
        <input
          type="range"
          min={1}
          max={3}
          step={0.05}
          value={zoom}
          onChange={(e) => onZoomChange(Number(e.target.value))}
        />
      </div>
      <div className="cropper-actions">
        <button type="button" className="ghost" onClick={onCancel}>
          취소
        </button>
        <button type="button" onClick={confirm} disabled={!naturalSize}>
          이 영역으로 사용
        </button>
      </div>
    </div>
  );
}
