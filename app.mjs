import { DATA_DIR, createLogger, ensureConfigFile, getConfig, reloadConfig } from './config.mjs';
import { CaptainCore } from './core.mjs';
import { createAdminApp } from './admin.mjs';

const coreLogger = createLogger('core');
const adminLogger = createLogger('admin');

async function main() {
  ensureConfigFile();
  let cfg = getConfig();
  coreLogger.info(`Captain starting, data dir: ${DATA_DIR}`);

  const core = new CaptainCore({ logger: coreLogger });
  await core.start();

  const admin = createAdminApp({ core, logger: adminLogger });
  admin.ensureAdminPassword();

  await new Promise((resolve, reject) => {
    admin.server.listen(cfg.server.port, cfg.server.bind, () => {
      coreLogger.info(`后台已启动: http://${cfg.server.bind}:${cfg.server.port}`);
      resolve();
    });
    admin.server.on('error', reject);
  });

  const shutdown = async (signal) => {
    coreLogger.info(`收到 ${signal}，正在关闭`);
    try {
      await core.stop();
    } catch {
      // ignore
    }
    admin.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', async () => {
    coreLogger.info('收到 SIGHUP，重载配置');
    try {
      cfg = reloadConfig();
      await core.reload();
    } catch (error) {
      coreLogger.error(`重载失败: ${error.message}`);
    }
  });

  process.on('unhandledRejection', (error) => {
    coreLogger.error(`Unhandled rejection: ${error?.stack || error}`);
  });
  process.on('uncaughtException', (error) => {
    coreLogger.error(`Uncaught exception: ${error?.stack || error}`);
  });
}

main().catch((error) => {
  coreLogger.error(`启动失败: ${error?.stack || error}`);
  process.exit(1);
});
