import { useEffect, useRef } from "react";
import type { BoardCommand } from "../types";

// 좌표계: board 명령의 x/y/x1/y1/x2/y2/w/h/r은 모두 0~100 사이의 상대값이다. 캔버스 가장자리에
// 딱 붙여 그리면 테두리에 잘려 보이므로, 실제 그리기 영역 안쪽에 약간의 여백(PADDING_RATIO)을
// 두고 그 안에서만 0~100을 매핑한다 — 화면 캡처에서 보였던 "글자가 테두리에 걸려 잘리는" 문제의
// 원인 중 하나였다.
const PADDING_RATIO = 0.05;
const LINE_HEIGHT_RATIO = 1.35;
const BLOCK_GAP = 6; // 겹침 회피 시 이전 텍스트 블록과 최소 이만큼(px) 띄운다

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  // 글자 단위로 끊어도 자연스러운 한글 특성을 이용해, 너무 길면 그리기 영역(maxWidth)을 넘기기
  // 직전에 줄을 바꾼다.
  const chars = Array.from(text);
  const lines: string[] = [];
  let current = "";
  for (const ch of chars) {
    const next = current + ch;
    if (current && ctx.measureText(next).width > maxWidth) {
      lines.push(current);
      current = ch;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

interface TextBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function overlaps(a: TextBox, b: TextBox): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function Blackboard({ commands }: { commands: BoardCommand[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // 캔버스를 CSS 크기로만 늘리면(backing store 해상도는 그대로) 흐려지거나 좌표 계산이
    // 어긋날 수 있다 — devicePixelRatio를 반영한 실제 픽셀 크기로 backing store를 맞추고,
    // 이후 좌표 계산은 전부 "논리 크기(logicalW/H)" 기준으로 한다. 부모(.blackboard)의
    // clientWidth/Height를 쓰면 부모의 padding까지 캔버스 크기에 포함돼 좌표가 밀리므로,
    // 반드시 캔버스 자신의 렌더링된 박스 크기(getBoundingClientRect)를 기준으로 삼는다.
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const logicalW = rect.width;
    const logicalH = rect.height;
    if (logicalW === 0 || logicalH === 0) return;
    canvas.width = Math.max(1, Math.round(logicalW * dpr));
    canvas.height = Math.max(1, Math.round(logicalH * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, logicalW, logicalH);

    const padX = logicalW * PADDING_RATIO;
    const padY = logicalH * PADDING_RATIO;
    const drawW = logicalW - padX * 2;
    const drawH = logicalH - padY * 2;
    const px = (v: number) => padX + (v / 100) * drawW;
    const py = (v: number) => padY + (v / 100) * drawH;
    const pr = (v: number) => (v / 100) * Math.min(drawW, drawH); // 반지름은 짧은 변 기준으로 스케일

    // AI가 준 y 좌표는 서로 독립적이라, 텍스트가 길어 여러 줄로 자동 줄바꿈되면 바로 아래
    // 있는 다른 텍스트 블록과 겹칠 수 있다(실제로 이 문제로 글자가 겹쳐 보이는 버그가
    // 있었다). 지금까지 그린 텍스트의 사각 영역을 기억해뒀다가, 새로 그릴 텍스트가 가로로
    // 겹치는 기존 블록과 세로로도 겹치면 그 블록 아래로 밀어서 그린다.
    const drawnBoxes: TextBox[] = [];

    for (const cmd of commands) {
      switch (cmd.type) {
        case "clear":
          ctx.clearRect(0, 0, logicalW, logicalH);
          drawnBoxes.length = 0;
          break;
        case "text": {
          const fontSize = Math.max(10, Math.min(cmd.size ?? 15, 22));
          ctx.font = `600 ${fontSize}px "Pretendard", "Malgun Gothic", sans-serif`;
          ctx.fillStyle = cmd.color ?? "#ffffff";
          ctx.textAlign = "left";
          ctx.textBaseline = "top";

          const x = px(cmd.x);
          const maxWidth = Math.max(40, padX + drawW - x); // x부터 칠판 오른쪽 끝까지 남은 폭
          const lines = wrapText(ctx, cmd.text, maxWidth);
          const lineHeight = fontSize * LINE_HEIGHT_RATIO;
          const lineWidth = Math.max(...lines.map((l) => ctx.measureText(l).width), 1);

          let y = py(cmd.y);
          let box: TextBox = { left: x, right: x + lineWidth, top: y, bottom: y + lines.length * lineHeight };
          // 가로로 겹치는 기존 블록이 있으면 그 블록 바로 아래로 계속 밀어 내린다.
          let pushed = true;
          while (pushed) {
            pushed = false;
            for (const prev of drawnBoxes) {
              if (overlaps(box, prev)) {
                y = prev.bottom + BLOCK_GAP;
                box = { left: x, right: x + lineWidth, top: y, bottom: y + lines.length * lineHeight };
                pushed = true;
              }
            }
          }

          lines.forEach((line, i) => ctx.fillText(line, x, y + i * lineHeight));
          drawnBoxes.push(box);
          break;
        }
        case "line":
          ctx.strokeStyle = cmd.color ?? "#ffffff";
          ctx.lineWidth = cmd.width ?? 2;
          ctx.beginPath();
          ctx.moveTo(px(cmd.x1), py(cmd.y1));
          ctx.lineTo(px(cmd.x2), py(cmd.y2));
          ctx.stroke();
          break;
        case "rect": {
          const x = px(cmd.x);
          const y = py(cmd.y);
          const w = (cmd.w / 100) * drawW;
          const h = (cmd.h / 100) * drawH;
          ctx.strokeStyle = ctx.fillStyle = cmd.color ?? "#ffffff";
          if (cmd.fill) ctx.fillRect(x, y, w, h);
          else ctx.strokeRect(x, y, w, h);
          break;
        }
        case "circle":
          ctx.strokeStyle = ctx.fillStyle = cmd.color ?? "#ffffff";
          ctx.beginPath();
          ctx.arc(px(cmd.x), py(cmd.y), pr(cmd.r), 0, Math.PI * 2);
          if (cmd.fill) ctx.fill();
          else ctx.stroke();
          break;
        case "arrow": {
          const x1 = px(cmd.x1);
          const y1 = py(cmd.y1);
          const x2 = px(cmd.x2);
          const y2 = py(cmd.y2);
          ctx.strokeStyle = ctx.fillStyle = cmd.color ?? "#ffffff";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          const angle = Math.atan2(y2 - y1, x2 - x1);
          const headLen = 8;
          ctx.beginPath();
          ctx.moveTo(x2, y2);
          ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
          ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
          ctx.closePath();
          ctx.fill();
          break;
        }
      }
    }
  }, [commands]);

  return (
    <div className="blackboard">
      <canvas ref={canvasRef} className="blackboard-canvas" />
    </div>
  );
}
