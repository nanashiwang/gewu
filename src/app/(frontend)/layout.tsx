import React from "react";
import { cookies } from "next/headers";
import "./globals.css";
import { SiteNav } from "@/components/SiteNav";
import { FrontendFrame } from "@/components/FrontendFrame";
import { getCurrentUser } from "@/lib/auth";
import "./account.css";

// 前台依赖登录态和 Payload；避免生产构建阶段预渲染时误连数据库。
export const dynamic = "force-dynamic";

export const metadata = {
  title: "格物 — AI Skill 的可信与兼容控制平面",
  description:
    "让 AI Skill 拥有身份、版本、签名、兼容证据、失败记录和企业治理能力，适配用户已有模型、网关和本地 Runner。",
};

type ThemeMode = "light" | "dark";

const THEME_KEY = "gewu-theme";

function normalizeTheme(value?: string | null): ThemeMode {
  return value === "light" ? "light" : "dark";
}

// 在 React 注水前设置主题；同时写 cookie，让刷新时服务端也能直接渲染用户选择。
function createThemeInitScript(initialTheme: ThemeMode) {
  return `(function(){var KEY=${JSON.stringify(THEME_KEY)};var FALLBACK=${JSON.stringify(initialTheme)};function clean(t){return t==='light'||t==='dark'?t:null}function mode(t){return clean(t)||'dark'}function label(t){return t==='dark'?'切换到浅色主题':'切换到深色主题'}function icon(t){return t==='dark'?'☀':'☾'}function readCookie(){try{var m=document.cookie.match(new RegExp('(?:^|; )'+KEY+'=(light|dark)(?:;|$)'));return m?m[1]:null}catch(e){return null}}function persist(t){t=mode(t);try{localStorage.setItem(KEY,t)}catch(e){}try{document.cookie=KEY+'='+t+'; Path=/; Max-Age=31536000; SameSite=Lax'}catch(e){}}function pick(){var ls=null;try{ls=clean(localStorage.getItem(KEY))}catch(e){}var ck=clean(readCookie());var t=mode(ls||ck||FALLBACK);if(ls!==ck)persist(t);return t}function apply(t,save){t=mode(t);document.documentElement.setAttribute('data-theme',t);if(save)persist(t);document.querySelectorAll('[data-theme-toggle]').forEach(function(btn){btn.setAttribute('aria-label',label(t));btn.setAttribute('title',label(t));var i=btn.querySelector('[data-theme-icon]');if(i)i.textContent=icon(t)})}apply(pick(),false);function bind(){apply(document.documentElement.getAttribute('data-theme'),false);document.addEventListener('click',function(e){var target=e.target;var btn=target&&target.closest?target.closest('[data-theme-toggle]'):null;if(!btn)return;var cur=mode(document.documentElement.getAttribute('data-theme'));apply(cur==='dark'?'light':'dark',true)})}if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',bind,{once:true})}else{bind()}})();`;
}

export default async function FrontendLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const initialTheme = normalizeTheme((await cookies()).get(THEME_KEY)?.value);
  const user = await getCurrentUser();

  return (
    <html lang="zh-CN" data-theme={initialTheme} suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: createThemeInitScript(initialTheme),
          }}
        />
      </head>
      <body className="flex min-h-screen flex-col">
        <FrontendFrame
          signedIn={Boolean(user)}
          platformNavigation={<SiteNav initialTheme={initialTheme} />}
        >
          {children}
        </FrontendFrame>
      </body>
    </html>
  );
}
