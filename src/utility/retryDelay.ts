type NonZeroDigit = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
type Digit = NonZeroDigit | 0
export type Milliseconds = `${Digit}ms`
    | `${NonZeroDigit}${Digit}ms`
    | `${NonZeroDigit}${Digit}${Digit}ms`
    | `${NonZeroDigit}${Digit}${Digit}${Digit}ms`
    | `${NonZeroDigit}${Digit}${Digit}${Digit}${Digit}ms`

export const retryDelayGen = function*(initDelayMs: Milliseconds, maxDelayMs: Milliseconds) {
    let delayMs = parseInt(initDelayMs, 10)
    let maxDelay = parseInt(maxDelayMs, 10)
    let power = 1
    for (;;) {
        let noiseFactor = 0.9 + (Math.random() * 0.2) // 0.9 <= x < 1.1
        yield Math.min(delayMs * power, maxDelay) * noiseFactor // 1000 * (2^n) * noise
        power <<= 1 
    }
}