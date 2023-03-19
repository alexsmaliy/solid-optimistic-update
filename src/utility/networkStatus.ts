export const SYNCED = "synced"
export const SENT_REQUEST = "sent-request"
export const GOT_ERROR = "got-error"
export const SENT_RETRY = "sent-retry"
export const FAILED = "failed"

export type NetworkStatus = typeof SYNCED 
    | typeof SENT_REQUEST 
    | typeof GOT_ERROR 
    | typeof SENT_RETRY 
    | typeof FAILED