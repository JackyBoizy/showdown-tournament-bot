import "dotenv/config";
import WebSocket from "ws";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} from "discord.js";

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

discord.once("clientReady", async () => {
  console.log(`✅ Discord logged in as ${discord.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName("tournaments")
      .setDescription("Show currently ongoing Pokémon Showdown tournaments")
      .toJSON()
  ];

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(
    Routes.applicationCommands(discord.user.id),
    { body: commands }
  );

  console.log("✅ Slash command /tournaments registered");
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
  console.log("🟢 Connected to Pokémon Showdown");
  for (const room of ROOMS) {
    ws.send(`|/join ${room}`);
  }
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
      const parts = line.split("|");
      const format = parts[3];
      const name = parts[6] ?? format;

      const key = currentRoom; // one tournament per room
      if (activeTournaments.has(key)) continue;

      console.log(`🏆 Tournament detected: ${name} (${currentRoom})`);

      const channel = await discord.channels.fetch(CHANNEL_ID);
      const sent = await channel.send(
        `🏆 **Tournament Open!**\n` +
        `**Format:** ${name}\n` +
        `**Room:** ${currentRoom}\n` +
        `Join → https://play.pokemonshowdown.com/${currentRoom}`
      );

      activeTournaments.set(key, {
        room: currentRoom,
        format,
        name,
        messageId: sent.id,
        startTime: Date.now()
      });
    }

    // -------- TOURNAMENT ENDED (ALL CASES) --------
    if (
      line.startsWith("|tournament|end|") ||
      line.startsWith("|tournament|forceend") ||
      line.startsWith("|tournament|expire")
    ) {
      for (const [room, tour] of activeTournaments) {
        if (currentRoom && room !== currentRoom) continue;

        try {
          const channel = await discord.channels.fetch(CHANNEL_ID);
          const msg = await channel.messages.fetch(tour.messageId);
          await msg.delete();
          console.log(`🗑 Tournament ended: ${tour.name} (${room})`);
        } catch {}

        activeTournaments.delete(room);
        break;
      }
    }
  }
});

// ================= AUTO-CLEANUP =================
setInterval(async () => {
  const now = Date.now();

  for (const [room, tour] of activeTournaments) {
    if (now - tour.startTime < MAX_TOURNAMENT_AGE) continue;

    console.log(
      `🧹 Auto-cleaned tournament after 30m: ${tour.name} (${room})`
    );

    try {
      const channel = await discord.channels.fetch(CHANNEL_ID);
      const msg = await channel.messages.fetch(tour.messageId);
      await msg.delete();
    } catch {}

    activeTournaments.delete(room);
  }
}, CLEANUP_INTERVAL);

// ================= SLASH COMMAND =================
discord.on("interactionCreate", async (interaction) => {
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
