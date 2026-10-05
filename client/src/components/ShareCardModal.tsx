import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { assetIcon } from "../assetIcons";
import type { MyRanking } from "../types";
import { CAR_SPRITES, HOME_SPRITES } from "./TownHub";

// 자산 자랑 카드: 내 집·차·자산 구간·전체 순위를 세로 이미지(1080×1350, 인스타 피드 비율) 한 장으로 그려
// 기기 공유 창(카톡·인스타 등)으로 보내거나 이미지로 저장한다. 그림은 전부 이 기기의 캔버스에서 그린다.
// 자산은 정확한 금액 대신 구간("3억원대")만 넣는다 — 다른 사람이 보는 프로필과 같은 원칙.
const W = 1080;
const H = 1350;
const GAME_NAME = "인생 시뮬레이션 게임";

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // 이미지가 없어도 카드는 그린다
    img.src = src;
  });
}

/** 긴 글자가 카드 밖으로 나가지 않게 글자 크기를 줄인다. */
function fitFont(ctx: CanvasRenderingContext2D, text: string, weight: number, size: number, maxW: number) {
  let s = size;
  ctx.font = `${weight} ${s}px sans-serif`;
  while (s > 24 && ctx.measureText(text).width > maxW) {
    s -= 4;
    ctx.font = `${weight} ${s}px sans-serif`;
  }
}

async function drawCard(canvas: HTMLCanvasElement, me: MyRanking): Promise<void> {
  const ctx = canvas.getContext("2d")!;
  canvas.width = W;
  canvas.height = H;

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#1b1f3b");
  bg.addColorStop(1, "#4a2a6b");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // 순위
  ctx.fillStyle = "#ffd65a";
  fitFont(ctx, `🏆 전체 자산 랭킹 ${me.rank.toLocaleString()}위 / ${me.outOf.toLocaleString()}명`, 700, 46, W - 120);
  ctx.fillText(`🏆 전체 자산 랭킹 ${me.rank.toLocaleString()}위 / ${me.outOf.toLocaleString()}명`, W / 2, 90);

  // 아바타 + 닉네임 + 학력
  const avatar = me.avatarUrl ? await loadImage(me.avatarUrl) : null;
  const ax = W / 2;
  const ay = 230;
  const ar = 90;
  ctx.save();
  ctx.beginPath();
  ctx.arc(ax, ay, ar, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = "#2c3157";
  ctx.fill();
  ctx.clip();
  if (avatar) {
    ctx.drawImage(avatar, ax - ar, ay - ar, ar * 2, ar * 2);
  } else {
    ctx.fillStyle = "#fff";
    ctx.font = "700 90px sans-serif";
    ctx.fillText(me.nickname.slice(0, 1), ax, ay + 4);
  }
  ctx.restore();
  ctx.strokeStyle = "#ffd65a";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(ax, ay, ar, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = "#fff";
  fitFont(ctx, me.nickname, 700, 64, W - 160);
  ctx.fillText(me.nickname, W / 2, 380);
  ctx.fillStyle = "#c9c3e6";
  ctx.font = "500 36px sans-serif";
  ctx.fillText(`🎓 ${me.education}`, W / 2, 440);

  // 자산 구간(가장 크게)
  ctx.fillStyle = "#fff";
  fitFont(ctx, me.wealthBand, 800, 120, W - 120);
  ctx.fillText(me.wealthBand, W / 2, 570);
  ctx.font = "600 52px sans-serif";
  ctx.fillText("자산가", W / 2, 670);

  // 내 집 + 내 차(마을 지도와 같은 스프라이트). 바닥선에 맞춰 집을 뒤에, 차를 앞에 그린다.
  const homeSprite = (me.home && HOME_SPRITES[me.home]) || HOME_SPRITES.box;
  const carSprite = me.car ? CAR_SPRITES[me.car] : null;
  const [homeImg, carImg] = await Promise.all([
    loadImage(homeSprite.src),
    carSprite ? loadImage(carSprite.src) : Promise.resolve(null),
  ]);
  const ground = 1040;
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.beginPath();
  ctx.ellipse(W / 2, ground, 400, 40, 0, 0, Math.PI * 2);
  ctx.fill();
  if (homeImg) {
    const h = 300;
    const w = Math.min((homeImg.width / homeImg.height) * h, 520);
    ctx.drawImage(homeImg, W / 2 - w / 2 - (carImg ? 90 : 0), ground - h, w, h);
  }
  if (carImg) {
    const w = 300;
    const h = (carImg.height / carImg.width) * w;
    ctx.drawImage(carImg, W / 2 + 40, ground - h + 10, w, h);
  }

  // 보유 자산 한 줄
  const line = [
    me.home ? `${assetIcon("apartment", me.home)} ${me.home}` : "📦 박스집",
    me.car ? `${assetIcon("car", me.car)} ${me.car}` : null,
    me.luxuryCount > 0 ? `💎 명품 ${me.luxuryCount}개` : null,
  ]
    .filter(Boolean)
    .join("  ·  ");
  ctx.fillStyle = "#fff";
  fitFont(ctx, line, 600, 42, W - 120);
  ctx.fillText(line, W / 2, 1120);

  // 하단 문구 + 게임 주소
  ctx.fillStyle = "#c9c3e6";
  ctx.font = "500 36px sans-serif";
  ctx.fillText(me.home ? `현실은 박스집, 게임에선 ${me.home} ✨` : "지금은 박스집, 곧 펜트하우스 ✨", W / 2, 1200);
  ctx.fillStyle = "#ffd65a";
  ctx.font = "700 34px sans-serif";
  ctx.fillText(`${GAME_NAME} · ${window.location.host}`, W / 2, 1275);
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("이미지를 만들지 못했어요."))), "image/png")
  );
}

export function ShareCardModal({ onClose }: { onClose: () => void }) {
  const [me, setMe] = useState<MyRanking | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    (async () => {
      try {
        const m = await api.get<MyRanking>("/ranking/me");
        const canvas = document.createElement("canvas");
        await drawCard(canvas, m);
        const b = await toBlob(canvas);
        if (cancelled) return;
        url = URL.createObjectURL(b);
        setMe(m);
        setBlob(b);
        setPreview(url);
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError || e instanceof Error ? e.message : "카드를 만들지 못했어요.");
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, []);

  const shareText = me
    ? `나 지금 ${me.wealthBand} 자산가! 전체 ${me.rank.toLocaleString()}위 🏆 너도 해봐 → ${window.location.origin}`
    : "";

  // 이미지 파일 공유(안드로이드 크롬·웹뷰) → 안 되면 글만 공유 → 그것도 안 되면 자랑 문구 복사.
  async function share() {
    if (!blob) return;
    setMsg(null);
    const file = new File([blob], "my-wealth-card.png", { type: "image/png" });
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text: shareText });
      } else if (navigator.share) {
        await navigator.share({ text: shareText, url: window.location.origin });
      } else {
        await navigator.clipboard.writeText(shareText);
        setMsg("이 기기는 공유 창을 지원하지 않아 자랑 문구를 복사했어요. 이미지는 '이미지 저장'으로 받아 주세요.");
      }
    } catch (e) {
      if ((e as DOMException)?.name !== "AbortError") setMsg("공유하지 못했어요. '이미지 저장'으로 받아 주세요.");
    }
  }

  function download() {
    if (!preview) return;
    const a = document.createElement("a");
    a.href = preview;
    a.download = "my-wealth-card.png";
    a.click();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal share-card-modal" onClick={(e) => e.stopPropagation()}>
        <h2>📸 자산 자랑 카드</h2>
        {error && <p className="error">{error}</p>}
        {!preview && !error && <p className="muted">카드를 그리는 중…</p>}
        {preview && <img className="share-card-preview" src={preview} alt="내 자산 자랑 카드" />}
        {msg && <p className="muted">{msg}</p>}
        <div className="share-card-actions">
          <button disabled={!blob} onClick={share}>
            공유하기
          </button>
          <button className="ghost" disabled={!preview} onClick={download}>
            이미지 저장
          </button>
        </div>
        <button className="modal-close" onClick={onClose}>
          닫기
        </button>
      </div>
    </div>
  );
}
