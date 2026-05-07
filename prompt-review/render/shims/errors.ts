export const getErrnoCode = (e: any) => e?.code;
    export const toError = (e: any) => e instanceof Error ? e : new Error(String(e));
