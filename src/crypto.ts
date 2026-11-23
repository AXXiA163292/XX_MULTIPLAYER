// Sonolus public key (from https://wiki.sonolus.com/custom-server-specs/headers/sonolus-signature)
const SONOLUS_JWK: JsonWebKey = {
    key_ops: ['verify'],
    ext: true,
    kty: 'EC',
    x: 'd2B14ZAn-zDsqY42rHofst8rw3XB90-a5lT80NFdXo0',
    y: 'Hxzi9DHrlJ4CVSJVRnydxFWBZAgkFxZXbyxPSa8SJQw',
    crv: 'P-256',
}

let sonolusKey: Promise<CryptoKey> | undefined
const getSonolusKey = () =>
    (sonolusKey ??= crypto.subtle.importKey('jwk', SONOLUS_JWK, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
        'verify',
    ]))

export const b64decode = (s: string): Uint8Array => {
    const normalized = s.trim().replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=')
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
}

export const b64encode = (b: Uint8Array): string => {
    let s = ''
    for (const x of b) s += String.fromCharCode(x)
    return btoa(s)
}

const b64url = (b: Uint8Array) => b64encode(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64url = (s: string) => b64decode(s)

/** Verifies a message signed by Sonolus (ECDSA P-256 / SHA-256, base64 signature). */
export async function verifySonolusSignature(body: Uint8Array, signatureB64: string): Promise<boolean> {
    if (!signatureB64) return false
    try {
        return await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            await getSonolusKey(),
            b64decode(signatureB64),
            body,
        )
    } catch {
        return false
    }
}

const hmacKey = (secret: string) =>
    crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
        'verify',
    ])

/** Signs an arbitrary JSON payload: base64url(json).base64url(hmac). */
export async function signToken(secret: string, payload: unknown): Promise<string> {
    const body = b64url(new TextEncoder().encode(JSON.stringify(payload)))
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(body)))
    return `${body}.${b64url(sig)}`
}

export async function verifyToken<T extends { exp: number }>(secret: string, token: string): Promise<T | null> {
    const [body, sig] = token.split('.')
    if (!body || !sig) return null
    try {
        const ok = await crypto.subtle.verify(
            'HMAC',
            await hmacKey(secret),
            unb64url(sig),
            new TextEncoder().encode(body),
        )
        if (!ok) return null
        const payload = JSON.parse(new TextDecoder().decode(unb64url(body))) as T
        return payload.exp > Date.now() ? payload : null
    } catch {
        return null
    }
}

export const randomId = (len: number): string => {
    const chars = 'abcdefghijkmnpqrstuvwxyz23456789'
    const bytes = crypto.getRandomValues(new Uint8Array(len))
    return Array.from(bytes, (b) => chars[b % chars.length]).join('')
}