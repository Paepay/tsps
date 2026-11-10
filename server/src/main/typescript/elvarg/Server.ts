// Provide minimal browser globals for libs that expect window (e.g., phaser).
(global as any).window = (global as any).window ?? {};
(global as any).document = (global as any).document ?? { documentElement: {}, createElement: () => ({ canPlayType: () => "", getContext: () => ({ fillRect: () => {}, drawImage: () => {}, getImageData: () => ({ data: [0,0,0,0] }), putImageData: () => {} }) }) };
if (typeof (global as any).navigator === "undefined") {
(global as any).navigator = {};
}
(global as any).Image = (global as any).Image ?? function () { return {}; };
(global as any).HTMLCanvasElement = (global as any).HTMLCanvasElement ?? function () {};
import * as path from "path";
import * as fs from "fs";
import Module = require("module");
import { GameBuilder } from "./game/GameBuilder";
import { GameConstants } from "./game/GameConstants";
import { CachePipeline } from "./game/cache/CachePipeline";
import { World } from "./game/World";
import { ObjectManager } from "./game/entity/impl/object/ObjectManager";
import { NetworkBuilder } from "./net/NetworkBuilder";
import { NetworkConstants } from "./net/NetworkConstants";
import { PluginManager } from "./plugins/PluginManager";
import { Flooder } from "./util/flood/Flooder";
import { ServerLogger } from "./util/ServerLogger";
import { PlayerPunishment } from "./util/PlayerPunishment";
import { Accounts } from "./game/entity/impl/player/Accounts";

export interface ShutdownOptions {
  /**
   * Runs first, before plugins are told the server is shutting down. Throwing cancels the
   * shutdown with nothing stopped, so a check that can fail belongs here rather than in afterPersist.
   */
  beforeShutdown?: () => void;
  /** Runs after player persistence succeeds, before exit. Throwing cancels the shutdown. */
  afterPersist?: () => void;
  /** Process exit code for a plain exit (ignored by the nodemon restart mode). */
  exitCode?: number;
  /**
   * Called once, with why, when this shutdown does not go ahead: another shutdown is already
   * in progress, beforeShutdown threw, player persistence failed, or afterPersist threw. The
   * server keeps running.
   */
  onCancelled?: (reason: string) => void;
}

function notifyCancelled(options: ShutdownOptions, reason: string): void {
  try {
    options.onCancelled?.(reason);
  } catch (err) {
    console.error("[shutdown] onCancelled hook failed", err);
  }
}

export class Server {
  private static flooder: Flooder = new Flooder();
  public static PRODUCTION = false;
  private static DEBUG_LOGGING = false;
  private static logger = {
    debug: (...args: any[]) => console.debug(...args),
    info: (...args: any[]) => console.info(...args),
    warn: (...args: any[]) => console.warn(...args),
    error: (...args: any[]) => console.error(...args),
  };
  private static updating = false;
  private static consolePatched = false;
  private static shuttingDown = false;
  private static gracefulHandlersInstalled = false;

  /**
   * Process exit codes the host launcher's supervisor interprets. A launcher that
   * sees EXIT_UPDATE_REQUIRED knows to download and install the current release and
   * start the server again; any other non-zero code is a failure it must not loop on.
   */
  public static readonly EXIT_NORMAL = 0;
  public static readonly EXIT_UPDATE_REQUIRED = 10;
  public static readonly EXIT_AUTH_FAILURE = 11;
  public static readonly EXIT_CONFIG_FAILURE = 12;
  public static readonly EXIT_FATAL = 13;
  /**
   * Set when a plugin asks for the server to stop so the host can install a newer
   * release. The shutdown path exits with EXIT_UPDATE_REQUIRED so the supervisor
   * distinguishes "update and restart" from an operator stopping the server.
   */
  private static updateRequired = false;

  private static setupFileLogging() {
    if (Server.consolePatched) return;
    ServerLogger.install(path.join(process.cwd(), "logs", "server.log"));
    Server.consolePatched = true;
  }

  /**
   * Announce a numbered startup stage, matching the launcher's scheme
   * (server/scripts/release/StartServer.bat) so a world owner reads the launcher
   * and the server as one timeline. The launcher owns 1-2 (release verification
   * and download); the core owns 3 (cache); the PaeScape plugin owns 4-7
   * (platform connectivity, authentication, lease, readiness). Wall-clock
   * timestamps let the launcher's lines and these interleave legibly.
   */
  public static stage(n: number, name: string): void {
    console.info(`[${Server.timestamp()}] [server] [stage ${n}/7] ${name}`);
  }

  /** A completed startup-stage outcome, e.g. the cache revision that is now active. */
  public static ok(n: number, message: string): void {
    console.info(`[${Server.timestamp()}] [server] stage ${n}/7 complete: ${message}`);
  }

  /** Local wall-clock HH:MM:SS, matching the launcher's timestamp format. */
  private static timestamp(): string {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  private static installProductionPathResolver() {
    const moduleAny = Module as any;
    if (moduleAny.__elvargProdPathResolverInstalled) {
      return;
    }
    moduleAny.__elvargProdPathResolverInstalled = true;

    const originalResolveFilename = moduleAny._resolveFilename;
    const cwd = process.cwd();
    const sourceRoot = path.join(cwd, "src", "main", "typescript", "elvarg");
    const distRoot = path.join(cwd, "dist");
    const pluginsRoot = path.join(cwd, "plugins");
    const brokenPluginsPrefix = `${path.sep}Users${path.sep}plugins${path.sep}`;

    const resolveCandidate = (request: string, parent?: NodeModule): string => {
      if (typeof request !== "string" || request.length === 0) {
        return request;
      }

      const parentFilename =
        parent && typeof (parent as any).filename === "string"
          ? (parent as any).filename
          : null;
      const absoluteRequest =
        path.isAbsolute(request)
          ? request
          : parentFilename
            ? path.resolve(path.dirname(parentFilename), request)
            : request;

      if (absoluteRequest.startsWith(sourceRoot)) {
        const relativePath = path.relative(sourceRoot, absoluteRequest);
        return path.join(distRoot, relativePath);
      }

      if (absoluteRequest.startsWith(brokenPluginsPrefix)) {
        const relativePath = absoluteRequest.slice(brokenPluginsPrefix.length);
        return path.join(pluginsRoot, relativePath);
      }

      return request;
    };

    moduleAny._resolveFilename = function patchedResolveFilename(
      request: string,
      parent: NodeModule | undefined,
      isMain: boolean,
      options: any
    ) {
      try {
        return originalResolveFilename.call(this, request, parent, isMain, options);
      } catch (originalError) {
        const rewritten = resolveCandidate(request, parent);
        if (rewritten === request) {
          throw originalError;
        }

        const directExists =
          fs.existsSync(rewritten) ||
          fs.existsSync(`${rewritten}.js`) ||
          fs.existsSync(`${rewritten}.json`) ||
          fs.existsSync(`${rewritten}.node`);
        if (!directExists) {
          throw originalError;
        }

        return originalResolveFilename.call(this, rewritten, parent, isMain, options);
      }
    };
  }

  private static installGlobalCrashHandlers() {
    process.on("uncaughtException", (err) => {
      console.error("[fatal] uncaughtException", err);
    });
    process.on("unhandledRejection", (reason) => {
      console.error("[fatal] unhandledRejection", reason);
    });
  }

  private static installGracefulShutdownHandlers() {
    if (Server.gracefulHandlersInstalled) {
      return;
    }
    Server.gracefulHandlersInstalled = true;

    process.on("SIGINT", () => {
      void Server.gracefulShutdown("SIGINT");
    });
    process.on("SIGTERM", () => {
      void Server.gracefulShutdown("SIGTERM");
    });
    // Closing the terminal the server runs in.
    process.on("SIGHUP", () => {
      void Server.gracefulShutdown("SIGHUP");
    });
    process.once("SIGUSR2", () => {
      void Server.gracefulShutdown("SIGUSR2", "restart");
    });
  }

  private static async gracefulShutdown(
    reason: string,
    mode: "exit" | "restart" = "exit",
    options: ShutdownOptions = {}
  ): Promise<void> {
    if (Server.shuttingDown) {
      console.info(`[shutdown] ${reason} ignored: shutdown already in progress`);
      notifyCancelled(options, "a shutdown is already in progress");
      return;
    }
    Server.shuttingDown = true;

    try {
      options.beforeShutdown?.();
    } catch (err) {
      console.error("[shutdown] beforeShutdown hook failed; shutdown cancelled before anything stopped.", err);
      Server.shuttingDown = false;
      notifyCancelled(options, err instanceof Error ? err.message : String(err));
      return;
    }

    try {
      const onlinePlayers = World.getPlayers().sizeReturn();
      console.info(
        `[shutdown] ${reason} received. Persisting ${onlinePlayers} online players...`
      );
      PluginManager.emitServerShutdown({ timestamp: Date.now() });
      const saved = World.savePlayers("shutdown");
      // Last-played times are written lazily (Accounts.touchLastPlayed).
      Accounts.flush();
      await Promise.all([GameConstants.PLAYER_PERSISTENCE.flush(), PlayerPunishment.flush()]);
      if (saved.failed > 0) throw new Error(`${saved.failed} player snapshot(s) failed`);
      console.info("[shutdown] Player persistence completed.");
    } catch (err) {
      console.error("[shutdown] Persistence failed; shutdown cancelled. Fix the error and retry the shutdown.", err);
      Server.shuttingDown = false;
      notifyCancelled(options, `saving players failed (${err instanceof Error ? err.message : String(err)})`);
      return;
    }

    try {
      options.afterPersist?.();
    } catch (err) {
      console.error("[shutdown] afterPersist hook failed; shutdown cancelled.", err);
      Server.shuttingDown = false;
      notifyCancelled(options, err instanceof Error ? err.message : String(err));
      return;
    }

    try {
      console.info(`[shutdown] Removed ${ObjectManager.removePluginObjects()} plugin objects.`);
    } catch (err) {
      console.error("[shutdown] Removing plugin objects failed", err);
    }

    try {
      console.info(`[shutdown] Removed ${PluginManager.removeUnownedPluginNpcs()} plugin NPCs.`);
    } catch (err) {
      console.error("[shutdown] Removing plugin NPCs failed", err);
    }

    if (mode === "restart") {
      console.info("[shutdown] Continuing nodemon restart (SIGUSR2).");
      process.kill(process.pid, "SIGUSR2");
      return;
    }

    process.exit(options.exitCode ?? 0);
  }

  public static async main(args: string[]): Promise<void> {
    try {
      Server.setupFileLogging();
      Server.installGlobalCrashHandlers();
      Server.installGracefulShutdownHandlers();
      Server.installProductionPathResolver();

      const productionArg = args.find((arg) => arg === "0" || arg === "1");
      if (productionArg) {
        Server.PRODUCTION = productionArg === "1";
      }
      const disablePlayerBots = args.includes("--disablePlayerBots");
      if (disablePlayerBots) {
        process.env.DISABLE_PLAYER_BOTS = "1";
        console.info("[Server] --disablePlayerBots enabled");
      }
      const stressTestArg = args.find((arg) => arg.startsWith("--stressTest"));
      if (stressTestArg) {
        const [, rawCount] = stressTestArg.split("=");
        const count = rawCount ? Number(rawCount) : 300;
        process.env.STRESS_TEST_BOT_COUNT = String(
          Number.isFinite(count) && count > 0 ? Math.floor(count) : 300
        );
        // Stress-test bots replace the normal PvP/economy bot population.
        process.env.DISABLE_PLAYER_BOTS = "1";
        // Bots are normally excluded from visibility work; a stress run wants that
        // cost measured, so opt in unless explicitly disabled.
        if (process.env.STRESS_TEST_BOT_UPDATES !== "0") {
          process.env.STRESS_TEST_BOT_UPDATES = "1";
        }
        console.info(
          `[Server] --stressTest enabled (${process.env.STRESS_TEST_BOT_COUNT} bots, PlayerBots disabled,` +
          ` botVisibilityUpdates=${process.env.STRESS_TEST_BOT_UPDATES})`
        );
      }

      // Startup stage 3/7 (the launcher owns 1-2, the PaeScape plugin owns 4-7).
      // Reading target.txt first turns a missing or malformed target into a clear
      // stage outcome instead of a raw stack trace, and names the revision the
      // server will run.
      Server.stage(3, "checking the cache revision");
      const cache = await CachePipeline.initialize();
      console.info(`[cache] active ${cache.name} (revision ${cache.revision})`);
      Server.ok(3, `cache revision ${cache.revision} ready (${cache.name})`);

      PluginManager.loadFromDirectory(path.join(process.cwd(), "plugins"));

      console.debug(
        `[server] initializing in ${
          Server.PRODUCTION ? "production" : "development"
        } mode`
      );
      // Start game logic (schedules GameEngine ticks, loads definitions, etc.)
      Server.stage(7, "starting the game loop and listening for players");
      new GameBuilder().initialize();
      Server.releaseStartupMemory();
      new NetworkBuilder().initialize(NetworkConstants.WEBSOCKET_PORT);
    } catch (e) {
      // A world owner reads the staged line and the remediation first; the raw
      // error (with its stack) is kept one line below for the support channel.
      const detail = e instanceof Error ? e.message : String(e);
      console.error(
        `[server] startup failed. ${Server.startupRemediation()} (${detail})`
      );
      console.error("[server] technical detail:", e);
      process.exit(1);
    }
  }

  /**
   * A short, actionable hint for a failed bootstrap, keyed off what the server was
   * doing. The server cannot always tell which step failed, so the message names
   * the likely causes rather than guessing one.
   */
  private static startupRemediation(): string {
    return (
      "The server could not start. Check that the cache directory matches target.txt " +
      "(the launcher verifies this at startup stage 3/7), that no other process holds " +
      "port " + NetworkConstants.WEBSOCKET_PORT + ", and that the packaged files were not modified. " +
      "If it repeats, re-run the launcher so it re-verifies the release."
    );
  }

  /**
   * Startup peaks well above the steady heap, and the tick loop never idles long enough for V8's
   * memory reducer to hand the freed pages back (~300 MiB on native Node). One last-resort GC does.
   */
  private static releaseStartupMemory(): void {
    try {
      require("v8").setFlagsFromString("--expose-gc");
      require("vm").runInNewContext("gc")({ type: "major", execution: "sync", flavor: "last-resort" });
    } catch {
      // Runtimes without these builtins (the browser host's WebContainer) manage their own memory.
    }
  }

  public static logDebug(logMessage: string) {
    if (!Server.DEBUG_LOGGING) {
      return;
    }

    Server.logger.info(logMessage);
  }

  public static getLogger() {
    return Server.logger;
  }

  /** True from the start of a graceful shutdown until it exits or cancels itself. */
  public static isShuttingDown(): boolean {
    return Server.shuttingDown;
  }

  public static isUpdating() {
    return Server.updating;
  }

  public static setUpdating(isUpdating: boolean) {
    Server.updating = isUpdating;
  }

  /**
   * Ask the server to shut down gracefully. A number is the process exit code the
   * hosted launcher's supervisor interprets; an object is the shutdown options.
   * A plugin that has detected a newer approved release calls shutdownForUpdate()
   * instead, which exits with EXIT_UPDATE_REQUIRED so the host installs it and restarts.
   */
  public static shutdown(
    reason: string = "shutdown",
    exitCodeOrOptions: number | ShutdownOptions = {},
  ): void {
    const options: ShutdownOptions =
      typeof exitCodeOrOptions === "number" ? { exitCode: exitCodeOrOptions } : exitCodeOrOptions;
    void Server.gracefulShutdown(reason, "exit", options);
  }

  /** Shut down because the platform published a newer release the host must install. */
  public static shutdownForUpdate(reason: string = "paescape-update"): void {
    Server.updateRequired = true;
    Server.shutdown(reason, Server.EXIT_UPDATE_REQUIRED);
  }

  /** True when a plugin requested an update-and-restart rather than an ordinary stop. */
  public static isUpdateRequired(): boolean {
    return Server.updateRequired;
  }

  public static getFlooder() {
    return Server.flooder;
  }
}

if (require.main === module) {
  void Server.main(process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["1"]);
}
