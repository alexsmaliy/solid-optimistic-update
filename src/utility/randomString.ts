export default function randomString(length:number) {
    const bytes = new Uint8Array(Math.ceil(length / 2))
    crypto.getRandomValues(bytes)
    return Array
       .from(bytes, byte => byte.toString(16).padStart(2, "0"))
       .join("")
       .substring(0, length)
}