export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const log = (who: string, msg: string) => console.log(`${new Date().toISOString().slice(11, 19)} [${who}] ${msg}`);
