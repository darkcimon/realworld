// 클라이언트가 보낸 값은 모두 조작될 수 있다고 보고 서버에서 다시 확인한다(입력 검증 모음).
import type { NextFunction, Request, Response } from "express";

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g; // 제어·방향 전환 문자

/** 닉네임: 앞뒤 공백·제어 문자 제거, 1~20자. 비어 있으면 null(=바꾸지 않음). */
export function cleanNickname(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw { status: 400, message: "닉네임이 올바르지 않아요." };
  const name = raw.replace(CONTROL_CHARS, "").trim();
  if (!name) return null;
  if ([...name].length > 20) throw { status: 400, message: "닉네임은 20자까지 쓸 수 있어요." };
  return name;
}

const RASTER = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const SVG_UTF8 = /^data:image\/svg\+xml;utf8,/;

/** 파일 앞부분(매직 바이트)이 정말 그 형식인지 — MIME만 바꿔 다른 파일을 올리는 걸 막는다. */
function magicMatches(kind: string, bytes: Buffer): boolean {
  if (kind === "png") return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (kind === "jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (kind === "webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

/**
 * 이미지는 데이터 URL만 받는다(외부 주소를 넣으면 다른 이용자 화면이 그 서버로 요청을 보내 IP가 새고,
 * 바뀌어도 서버가 모른다). PNG/JPEG/WebP는 크기와 매직 바이트를, 아바타 프리셋 SVG는 스크립트·이벤트 속성이 없는지 본다.
 */
export function checkImageDataUrl(raw: unknown, opts: { maxBytes: number; allowSvg?: boolean }): string {
  if (typeof raw !== "string") throw { status: 400, message: "이미지가 올바르지 않아요." };
  const m = RASTER.exec(raw);
  if (m) {
    const bytes = Buffer.from(m[2], "base64");
    if (bytes.length > opts.maxBytes) {
      throw { status: 413, message: `이미지가 너무 커요 (최대 ${Math.round(opts.maxBytes / 1024)}KB).` };
    }
    if (!magicMatches(m[1], bytes)) throw { status: 400, message: "이미지 파일이 올바르지 않아요." };
    return raw;
  }
  if (opts.allowSvg && SVG_UTF8.test(raw)) {
    if (raw.length > 16_000) throw { status: 413, message: "이미지가 너무 커요." };
    let svg: string;
    try {
      svg = decodeURIComponent(raw.slice(raw.indexOf(",") + 1));
    } catch {
      throw { status: 400, message: "이미지가 올바르지 않아요." };
    }
    if (/<script|<foreignObject|\son[a-z]+\s*=|javascript:|href\s*=\s*["']?\s*(?!#)/i.test(svg)) {
      throw { status: 400, message: "허용되지 않는 이미지예요." };
    }
    return raw;
  }
  throw { status: 400, message: "PNG·JPEG·WebP 이미지만 올릴 수 있어요." };
}

/** 위도·경도: 숫자이고 지구 위의 값이어야 한다. */
export function checkLatLng(lat: unknown, lng: unknown): { lat: number; lng: number } {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) {
    throw { status: 400, message: "위치 값이 올바르지 않아요." };
  }
  return { lat: la, lng: ln };
}

/** 회원가입: 이메일 형식·길이, 비밀번호 6~72자(bcrypt는 72바이트 뒤를 무시한다). */
export function checkCredentials(email: unknown, password: unknown): { email: string; password: string } {
  if (typeof email !== "string" || typeof password !== "string") throw { status: 400, message: "이메일과 비밀번호를 입력해 주세요." };
  const e = email.trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw { status: 400, message: "이메일 형식이 올바르지 않아요." };
  if (password.length < 6) throw { status: 400, message: "비밀번호는 6자 이상으로 정해 주세요." };
  if (Buffer.byteLength(password) > 72) throw { status: 400, message: "비밀번호가 너무 길어요 (72바이트 이하)." };
  return { email: e, password };
}

/**
 * IP별 요청 수 제한(메모리, 서버 1대 기준). 비밀번호 대입, 비회원 계정 대량 생성(신고 조작에 악용),
 * 신고 남발을 막는다. app.set("trust proxy", 1)이어야 Railway 프록시 뒤의 실제 IP를 본다.
 */
export function rateLimit(opts: { windowMs: number; max: number; name: string }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, opts.windowMs).unref();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.resetAt <= now) {
      h = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, h);
    }
    h.count += 1;
    if (h.count > opts.max) {
      res.setHeader("Retry-After", String(Math.ceil((h.resetAt - now) / 1000)));
      res.status(429).json({ error: "요청이 너무 많아요. 잠시 뒤에 다시 해 주세요." });
      return;
    }
    next();
  };
}
