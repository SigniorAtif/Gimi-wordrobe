// "@api-impl" resolves to tauri.ts, or to mock.ts when VITE_MOCK=1 (see vite.config.ts).
export { api } from "@api-impl";
export * from "./api";
export type * from "./types";
