import "dotenv/config";
import WebSocket from "ws";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} from "discord.js";

// ================= LOGGER =================
function log(level, message, extra = null) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  if (extra !== null) console.log(prefix, message, extra);
  else console.log(prefix, message);
}

// ================= CONFIG =================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = "1453914494823563339";
const PS_SERVER = "wss://sim3.psim.us/showdown/websocket";

// High-traffic tournament rooms (~90% coverage)
const ROOMS = [
  "lobby",
  "ou",
  "monotype",
  "nationaldex",
  "randombattle",
  "tournaments",
  "toursminigames",
  "toursplaza",
  "smogondoubles"
];

// Auto-clean settings
const MAX_TOURNAMENT_AGE = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL = 5 * 60 * 1000;   // every 5 minutes

// ================= DISCORD =================
const discord = new Client({
  intents: [GatewayIntentBits.Guilds]
});

async function getDiscordChannel() {
  try {
    return await discord.channels.fetch(CHANNEL_ID);
  } catch (err) {
    log("error", "Cannot access Discord channel", err?.code);
    return null;
  }
}

discord.once("clientReady", async () => {
  log("info", `Discord logged in as ${discord.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName("tournaments")
      .setDescription("Show currently ongoing Pokémon Showdown tournaments")
      .toJSON()
  ];

  try {
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    await rest.put(
      Routes.applicationCommands(discord.user.id),
      { body: commands }
    );
    log("info", "Slash command /tournaments registered");
  } catch (err) {
    log("error", "Failed to register slash commands", err?.code);
  }
});

await discord.login(DISCORD_TOKEN);

// ================= STATE =================
// key = room
const activeTournaments = new Map();
/*
{
  room,
  format,
  name,
  messageId,
  startTime
}
*/
let currentRoom = null;

// ================= SHOWDOWN =================
const ws = new WebSocket(PS_SERVER);

ws.on("open", () => {
  log("info", "Connected to Pokémon Showdown");
  for (const room of ROOMS) {
    ws.send(`|/join ${room}`);
  }
});

ws.on("close", () => {
  log("warn", "Disconnected from Pokémon Showdown");
});

ws.on("error", err => {
  log("error", "Showdown WebSocket error", err.message);
});

ws.on("message", async (data) => {
  const lines = data.toString().split("\n");

  for (const line of lines) {
    if (!line) continue;

    // -------- ROOM CONTEXT --------
    if (line.startsWith(">")) {
      currentRoom = line.slice(1);
      continue;
    }

    // -------- TOURNAMENT CREATED --------
    if (line.startsWith("|tournament|create|") && currentRoom) {
      if (activeTournaments.has(currentRoom)) continue;

      const parts = line.split("|");
      const format = parts[3];
      const name = parts[6] ?? format;

      log("info", `Tournament detected: ${name} (${currentRoom})`);

      const channel = await getDiscordChannel();
      if (!channel) continue;

      let sent;
      try {
        sent = await channel.send(
          `🏆 **Tournament Open!**\n` +
          `**Format:** ${name}\n` +
          `**Room:** ${currentRoom}\n` +
          `Join → https://play.pokemonshowdown.com/${currentRoom}`
        );
      } catch (err) {
        log("error", "Failed to post tournament message", err?.code);
        continue;
      }

      activeTournaments.set(currentRoom, {
        room: currentRoom,
        format,
        name,
        messageId: sent.id,
        startTime: Date.now()
      });
    }

    // -------- TOURNAMENT ENDED (WITH RESULTS) --------
    if (line.startsWith("|tournament|end|")) {
      const tour = activeTournaments.get(currentRoom);
      if (!tour) continue;

      let results = null;
      try {
        results = JSON.parse(line.slice(16))?.results ?? null;
      } catch {
        log("warn", "Failed to parse tournament results JSON");
      }

      const channel = await getDiscordChannel();
      if (channel) {
        try {
          if (results?.length) {
            const [w, r, t] = results;
            let msg =
              `🏁 **Tournament Finished!**\n` +
              `**Format:** ${tour.name}\n` +
              `🥇 **Winner:** ${w?.join(", ")}`;
            if (r) msg += `\n🥈 **Runner-up:** ${r.join(", ")}`;
            if (t) msg += `\n🥉 **3rd Place:** ${t.join(", ")}`;
            await channel.send(msg);
          } else {
            await channel.send(`🏁 **Tournament Finished:** ${tour.name}`);
          }
        } catch (err) {
          log("error", "Failed to post results", err?.code);
        }

        try {
          const m = await channel.messages.fetch(tour.messageId);
          await m.delete();
        } catch {}
      }

      log("info", `Tournament completed: ${tour.name}`);
      activeTournaments.delete(currentRoom);
    }

    // -------- FORCE / EXPIRE --------
    if (
      line.startsWith("|tournament|forceend") ||
      line.startsWith("|tournament|expire")
    ) {
      const tour = activeTournaments.get(currentRoom);
      if (!tour) continue;

      const channel = await getDiscordChannel();
      if (channel) {
        try {
          const m = await channel.messages.fetch(tour.messageId);
          await m.delete();
        } catch {}
      }

      log("warn", `Tournament force-ended: ${tour.name}`);
      activeTournaments.delete(currentRoom);
    }
  }
});

// ================= AUTO-CLEANUP =================
setInterval(async () => {
  const now = Date.now();

  for (const [room, tour] of activeTournaments) {
    if (now - tour.startTime < MAX_TOURNAMENT_AGE) continue;

    log("warn", `Auto-cleaned stale tournament: ${tour.name}`);

    const channel = await getDiscordChannel();
    if (channel) {
      try {
        const msg = await channel.messages.fetch(tour.messageId);
        await msg.delete();
      } catch {}
    }

    activeTournaments.delete(room);
  }
}, CLEANUP_INTERVAL);

// ================= SLASH COMMAND =================
discord.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "tournaments") {
    if (activeTournaments.size === 0) {
      await interaction.reply({
        content: "❌ There are no active tournaments right now.",
        ephemeral: true
      });
      return;
    }

    const list = [...activeTournaments.values()]
      .map(t => `• **${t.name}** (${t.room})`)
      .join("\n");

    await interaction.reply({
      content: "🏆 **Active Tournaments:**\n" + list,
      ephemeral: true
    });
  }
});
