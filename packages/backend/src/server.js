import Fastify from 'fastify';
import { registerRoutes } from './routes.js';
import { cleanupCache } from './cache.js';

const PORT = parseInt(process.env.PORT, 10) || 3000;
const CORS_ORIGINS = process.env.CORS_ORIGINS || '*';

/**
 * Create and configure Fastify instance
 * @returns {import('fastify').FastifyInstance}
 */
function createServer() {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      transport: process.env.NODE_ENV === 'development' ? {
        target: 'pino-pretty',
        options: {
          colorize: true
        }
      } : undefined
    }
  });

  // Register CORS plugin inline (no external dependency needed)
  fastify.addHook('onSend', async (request, reply, payload) => {
    const origins = CORS_ORIGINS === '*' ? '*' : CORS_ORIGINS.split(',').map(o => o.trim());
    
    if (origins === '*') {
      reply.header('Access-Control-Allow-Origin', '*');
    } else {
      const origin = request.headers.origin;
      if (origin && origins.includes(origin)) {
        reply.header('Access-Control-Allow-Origin', origin);
      }
    }
    
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    reply.header('Access-Control-Expose-Headers', 'X-Cache, X-Login-Wall, X-Blank-Page, X-Bot-Blocked, X-Timings, X-Error');
    
    return payload;
  });

  // Handle preflight requests
  fastify.options('*', async (request, reply) => {
    reply.status(204).send();
  });

  return fastify;
}

/**
 * Main application entry point
 */
async function main() {
  const server = createServer();

  // Register routes
  await registerRoutes(server);

  // Graceful shutdown handler
  const closeGracefully = async (signal) => {
    server.log.info(`Received signal ${signal}, shutting down gracefully...`);
    
    try {
      // Clean up cache
      cleanupCache();
      
      // Close server
      await server.close();
      server.log.info('Server closed successfully');
      
      process.exit(0);
    } catch (err) {
      server.log.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => closeGracefully('SIGTERM'));
  process.on('SIGINT', () => closeGracefully('SIGINT'));

  // Start server
  try {
    await server.listen({ port: PORT, host: '0.0.0.0' });
    server.log.info(`Screenshot service running on port ${PORT}`);
  } catch (err) {
    server.log.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

main();
