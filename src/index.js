
const { once } = require("node:events");
const {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
} = require("discord.js");

const { loadCommands } = require("./load-commands");
const { createHealthServer } = require("./health");
const { handlePrefixMessage } = require("./prefix-commands");

async function handleInteraction(interaction, commands, logger = console) {
  if (!interaction.isChatInputCommand()) return;

  const command = commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch {
    logger.error(`Command /${interaction.commandName} failed`);

    const payload = {
      content: "There was an error while executing this command.",
      flags: MessageFlags.Ephemeral,
    };

    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload);
      } else {
        await interaction.reply(payload);
      }
    } catch {
      logger.error("Could not send the command error response");
    }
  }
}

function createBot({
  token = (process.env.DISCORD_TOKEN || "").trim(),
  port = Number(process.env.PORT || "3000"),
  host = process.env.HOST || "0.0.0.0",
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  }),
  rest = new REST({ version: "10" }),
  commands = loadCommands(),
  logger = console,
  startupTimeoutMs = 25_000,
  shutdownTimeoutMs = 5_000,
} = {}) {
  let registered = false;
  let stopping = false;
  let phase = "starting";
  let stopPromise;

  const disconnected = new Set();
  const startup = new AbortController();

  client.commands = commands;

  function status() {
    const connected = client.isReady() && disconnected.size === 0;
    const ready = !stopping && registered && connected;

    return {
      ready,
      live: !stopping,
      discord: stopping ? "stopping" : connected ? phase : "disconnected",
      commands: commands.size,
      commandsRegistered: registered,
    };
  }

  const server = createHealthServer(status);

  client.on(Events.InteractionCreate, (interaction) =>
    handleInteraction(interaction, commands, logger),
  );

  // Prefix commands, for example: !commands
  client.on(Events.MessageCreate, (message) => {
    handlePrefixMessage(message).catch(() => {
      logger.error("Prefix command failed");
    });
  });

  client.on(Events.Error, () => logger.error("Discord client error"));
  client.on(Events.ShardDisconnect, (_event, id) => disconnected.add(id));
  client.on(Events.ShardReconnecting, (id) => disconnected.add(id));
  client.on(Events.ShardReady, (id) => disconnected.delete(id));
  client.on(Events.ShardResume, (id) => disconnected.delete(id));

  function stop() {
    if (stopPromise) return stopPromise;

    stopping = true;
    startup.abort();

    stopPromise = (async () => {
      let timer;

      try {
        await Promise.race([
          Promise.all([
            Promise.resolve().then(() => client.destroy()),
            new Promise((resolve) => server.close(resolve)),
          ]),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              server.closeAllConnections();
              reject(new Error("Discord shutdown timed out"));
            }, shutdownTimeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    })();

    return stopPromise;
  }

  async function start() {
    let timer;
    let abortStartup;

    try {
      startup.signal.throwIfAborted();

      if (!token.trim()) {
        throw new Error("DISCORD_TOKEN is required");
      }

      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error("PORT must be an integer between 0 and 65535");
      }

      server.listen(port, host);
      await once(server, "listening", { signal: startup.signal });

      logger.log(`Healthcheck listening on ${server.address().port}`);

      await Promise.race([
        (async () => {
          phase = "connecting";

          const ready = once(client, Events.ClientReady, {
            signal: startup.signal,
          });

          await Promise.all([client.login(token), ready]);
          startup.signal.throwIfAborted();

          phase = "registering_commands";

          const body = [...commands.values()].map((command) =>
            command.data.toJSON(),
          );

          await rest.setToken(token).put(
            Routes.applicationCommands(client.user.id),
            { body, signal: startup.signal },
          );

          startup.signal.throwIfAborted();

          registered = true;
          phase = "ready";

          logger.log(
            `Registered ${body.length} application slash command(s)`,
          );
        })(),

        new Promise((_, reject) => {
          abortStartup = () =>
            reject(new Error("Discord startup aborted"));

          startup.signal.addEventListener("abort", abortStartup, {
            once: true,
          });

          timer = setTimeout(
            () => reject(new Error("Discord startup timed out")),
            startupTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      const message =
        phase === "starting"
          ? error.message
          : phase === "registering_commands"
            ? "Discord command registration failed; check application permissions and connectivity"
            : "Discord login/readiness failed; check DISCORD_TOKEN and gateway connectivity";

      phase = "failed";
      await stop();
      throw new Error(message);
    } finally {
      clearTimeout(timer);

      if (abortStartup) {
        startup.signal.removeEventListener("abort", abortStartup);
      }
    }
  }

  return { start, stop, status, server, client };
}

async function main() {
  const app = createBot();

  const shutdown = (code) =>
    app.stop().then(
      () => process.exit(code),
      (error) => {
        console.error(error.message);
        process.exit(1);
      },
    );

  process.once("SIGINT", () => shutdown(0));
  process.once("SIGTERM", () => shutdown(0));

  process.on("unhandledRejection", () => {
    console.error("Unhandled rejection; stopping the bot");
    shutdown(1);
  });

  await app.start();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { createBot, handleInteraction };
