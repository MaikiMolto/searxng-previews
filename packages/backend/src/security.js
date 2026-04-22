import { URL } from 'url';

let BLOCK_PRIVATE_IPS = process.env.BLOCK_PRIVATE_IPS !== 'false';
let RATE_LIMIT_PER_MINUTE = parseInt(process.env.RATE_LIMIT_PER_MINUTE, 10) || 30;
const MAX_URL_LENGTH = 2048;

/**
 * Rate limiter store
 * @type {Map<string, {count: number, resetTime: number}>}
 */
const rateLimitStore = new Map();

/**
 * Check if an IP is private/local
 * @param {string} hostname - Hostname to check
 * @returns {boolean}
 */
function isPrivateIP(hostname) {
  // Check for localhost variants
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true;
  }
  
  // Check for IPv4 private ranges
  const ipv4PrivatePatterns = [
    /^127\./,                          // Loopback
    /^10\./,                           // Class A private
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // Class B private
    /^192\.168\./,                     // Class C private
    /^169\.254\./,                     // Link-local
    /^0\./,                            // Current network
    /^255\./,                          // Broadcast
  ];
  
  for (const pattern of ipv4PrivatePatterns) {
    if (pattern.test(hostname)) {
      return true;
    }
  }
  
  // Check for IPv6 private ranges
  const ipv6PrivatePatterns = [
    /^::1$/,                           // Loopback
    /^fc00:/i,                         // Unique local
    /^fe80:/i,                         // Link-local
    /^::ffff:127\./,                   // IPv4-mapped loopback
    /^::ffff:10\./,                    // IPv4-mapped Class A
    /^::ffff:172\.(1[6-9]|2[0-9]|3[0-1])\./,
    /^::ffff:192\.168\./,
  ];
  
  for (const pattern of ipv6PrivatePatterns) {
    if (pattern.test(hostname)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Validate a URL for security
 * @param {string} urlString - URL to validate
 * @returns {{valid: boolean, error?: string, url?: URL}}
 */
export function validateURL(urlString) {
  // Check URL length
  if (!urlString || urlString.length === 0) {
    return { valid: false, error: 'URL is required' };
  }
  
  if (urlString.length > MAX_URL_LENGTH) {
    return { valid: false, error: `URL exceeds maximum length of ${MAX_URL_LENGTH} characters` };
  }
  
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
  
  // Check protocol
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { valid: false, error: 'Only HTTP and HTTPS URLs are allowed' };
  }
  
  // Check for private IPs
  if (BLOCK_PRIVATE_IPS) {
    if (isPrivateIP(url.hostname)) {
      return { valid: false, error: 'Private IP addresses are not allowed' };
    }
  }
  
  return { valid: true, url };
}

/**
 * Clean up expired rate limit entries
 */
function cleanupRateLimits() {
  const now = Date.now();
  for (const [ip, data] of rateLimitStore.entries()) {
    if (now > data.resetTime) {
      rateLimitStore.delete(ip);
    }
  }
}

/**
 * Check rate limit for an IP
 * @param {string} ip - Client IP address
 * @returns {{allowed: boolean, remaining: number, resetIn: number}}
 */
export function checkRateLimit(ip) {
  cleanupRateLimits();
  
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute
  
  let data = rateLimitStore.get(ip);
  
  if (!data || now > data.resetTime) {
    // New window
    data = {
      count: 1,
      resetTime: now + windowMs
    };
    rateLimitStore.set(ip, data);
    
    return {
      allowed: true,
      remaining: RATE_LIMIT_PER_MINUTE - 1,
      resetIn: Math.ceil(windowMs / 1000)
    };
  }
  
  // Check limit
  if (data.count >= RATE_LIMIT_PER_MINUTE) {
    return {
      allowed: false,
      remaining: 0,
      resetIn: Math.ceil((data.resetTime - now) / 1000)
    };
  }
  
  // Increment count
  data.count++;
  
  return {
    allowed: true,
    remaining: RATE_LIMIT_PER_MINUTE - data.count,
    resetIn: Math.ceil((data.resetTime - now) / 1000)
  };
}

/**
 * Fastify plugin for rate limiting
 * @param {import('fastify').FastifyInstance} fastify
 * @param {Object} options
 */
export async function rateLimitPlugin(fastify, options) {
  fastify.addHook('onRequest', async (request, reply) => {
    // Get client IP (considering proxies)
    const ip = request.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
               request.ip || 
               request.socket?.remoteAddress || 
               'unknown';
    
    const rateLimit = checkRateLimit(ip);
    
    // Add rate limit headers
    reply.header('X-RateLimit-Limit', RATE_LIMIT_PER_MINUTE);
    reply.header('X-RateLimit-Remaining', Math.max(0, rateLimit.remaining));
    reply.header('X-RateLimit-Reset', rateLimit.resetIn);
    
    if (!rateLimit.allowed) {
      reply.status(429).send({
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Try again in ${rateLimit.resetIn} seconds.`
      });
      return;
    }
  });
}

/**
 * Get client IP from request
 * @param {import('fastify').FastifyRequest} request
 * @returns {string}
 */
export function getRateLimit() { return RATE_LIMIT_PER_MINUTE; }
export function setRateLimit(val) { RATE_LIMIT_PER_MINUTE = parseInt(val, 10) || 30; }
export function getBlockPrivateIps() { return BLOCK_PRIVATE_IPS; }
export function setBlockPrivateIps(val) { BLOCK_PRIVATE_IPS = !!val; }

export function getClientIP(request) {
  return request.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
         request.ip || 
         request.socket?.remoteAddress || 
         'unknown';
}
