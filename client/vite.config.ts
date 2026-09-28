import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // 같은 네트워크(와이파이)의 휴대폰 등에서 접속할 수 있게 0.0.0.0으로 바인딩
    // 공인 IP 직결/터널(cloudflared 등)로 외부에서 접속하면 매번 다른 Host 헤더(예:
    // *.trycloudflare.com)로 들어오는데, Vite는 기본적으로 모르는 Host를 DNS 리바인딩
    // 방지 차원에서 차단한다. 개발 편의를 위해 모두 허용한다(운영 배포에는 그대로 쓰지 말 것).
    allowedHosts: true,
    proxy: {
      "/api": "http://localhost:4000",
      "/socket.io": { target: "http://localhost:4000", ws: true },
    },
  },
});
