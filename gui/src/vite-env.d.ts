/// <reference types="vite/client" />

/** True in the static web client build (hash router, backend in the browser). */
declare const __VIBESHARE_WEB__: boolean;

/** When this page's bundle was built — shown in the UI so a stale page is obvious. */
declare const __VS_BUILD__: string;
