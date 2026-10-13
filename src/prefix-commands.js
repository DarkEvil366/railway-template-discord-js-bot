
async function handlePrefixMessage(message) {
  if (message.author.bot || !message.content.startsWith("!")) return;

  const command = message.content
    .slice(1)
    .trim()
    .split(/\s+/)[0]
    ?.toLowerCase();

  if (!command) return;

  if (command === "commands") {
    return message.reply(
      [
        "**TB Nodes Commands**",
        "`!commands` — Show commands",
        "`!services` — Railway services (admin)",
        "`!status` — Service status (admin)",
        "`!deploy <service name>` — Deploy a service (admin)",
        "`!restart <service name>` — Restart a service (admin)",
        "`!vps_list` — List services (admin)",
      ].join("\n")
    );
  }

  if (message.author.id !== process.env.ADMIN_USER_ID) {
    return message.reply("You are not authorized to use that command.");
  }

  return message.reply(
    "Prefix handler is working. Railway actions will be connected next."
  );
}

module.exports = { handlePrefixMessage };
