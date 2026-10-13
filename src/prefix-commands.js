
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require("discord.js");

const PREFIX = "!";
const API_URL = "https://backboard.railway.com/graphql/v2";

const pendingCreates = new Map();
const selectedServices = new Map();

function isAdmin(userId) {
  return Boolean(
    process.env.ADMIN_USER_ID &&
    userId === process.env.ADMIN_USER_ID
  );
}

async function railwayRequest(query, variables = {}) {
  if (!process.env.RAILWAY_TOKEN) {
    throw new Error("RAILWAY_TOKEN environment variable is missing.");
  }

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RAILWAY_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();

  if (!response.ok || result.errors?.length) {
    throw new Error(
      result.errors?.map((error) => error.message).join("; ") ||
      `Railway API error: HTTP ${response.status}`
    );
  }

  return result.data;
}

async function getServices() {
  const projectId = process.env.RAILWAY_PROJECT_ID;

  if (!projectId) {
    throw new Error("RAILWAY_PROJECT_ID is missing.");
  }

  const query = `
    query GetProjectServices($projectId: String!) {
      project(id: $projectId) {
        id
        name
        services {
          edges {
            node {
              id
              name
              serviceInstances {
                edges {
                  node {
                    environmentId
                    latestDeployment {
                      id
                      status
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await railwayRequest(query, { projectId });

  if (!data.project) {
    throw new Error("Railway project not found or access denied.");
  }

  return data.project.services.edges.map(({ node }) => {
    const instances = node.serviceInstances.edges.map(
      ({ node: instance }) => instance
    );

    return {
      id: node.id,
      name: node.name,
      instances,
    };
  });
}

function makeEmbed(title, description, color = 0x5865f2) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: "TB Nodes • Railway Manager" })
    .setTimestamp();
}

function manageRows() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("tb_services")
      .setLabel("Services")
      .setEmoji("📦")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("tb_monitor")
      .setLabel("Monitor")
      .setEmoji("📊")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("tb_create")
      .setLabel("Create")
      .setEmoji("➕")
      .setStyle(ButtonStyle.Success)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("tb_console")
      .setLabel("SSH / SSHX")
      .setEmoji("💻")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("tb_help")
      .setLabel("Commands")
      .setEmoji("📚")
      .setStyle(ButtonStyle.Secondary)
  );

  return [row1, row2];
}

function serviceSelectRow(services) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("tb_service_select")
      .setPlaceholder("Choose a Railway service")
      .addOptions(
        services.slice(0, 25).map((service) => ({
          label: service.name.slice(0, 100),
          value: service.id,
          description: `Service ID: ${service.id}`.slice(0, 100),
        }))
      )
  );
}

function serviceActionRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("tb_deploy_selected")
        .setLabel("Deploy")
        .setEmoji("🚀")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("tb_restart_selected")
        .setLabel("Restart")
        .setEmoji("🔄")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("tb_status_selected")
        .setLabel("Status")
        .setEmoji("📈")
        .setStyle(ButtonStyle.Primary)
    ),
  ];
}

async function deployService(serviceId, environmentId) {
  const query = `
    mutation DeployService($input: ServiceInstanceDeployV2Input!) {
      serviceInstanceDeployV2(input: $input)
    }
  `;

  return railwayRequest(query, {
    input: { serviceId, environmentId },
  });
}

async function restartService(deploymentId) {
  const query = `
    mutation RestartDeployment($id: String!) {
      deploymentRestart(id: $id)
    }
  `;

  return railwayRequest(query, { id: deploymentId });
}

async function handleManageInteraction(i) {
  if (!i.isButton() && !i.isStringSelectMenu()) return;
  if (!i.customId.startsWith("tb_")) return;

  if (!isAdmin(i.user.id)) {
    return i.reply({
      content: "⛔ You are not authorized to manage Railway services.",
      ephemeral: true,
    });
  }

  try {
    if (i.customId === "tb_services") {
      await i.deferUpdate();

      const services = await getServices();

      if (!services.length) {
        return i.editReply({
          embeds: [
            makeEmbed(
              "📦 No services found",
              "Your Railway project currently has no services."
            ),
          ],
          components: manageRows(),
        });
      }

      return i.editReply({
        embeds: [
          makeEmbed(
            "📦 Railway Services",
            services
              .map((s, index) => `${index + 1}. **${s.name}**`)
              .join("\n")
          ),
        ],
        components: [
          serviceSelectRow(services),
          ...manageRows(),
        ],
      });
    }

    if (i.customId === "tb_service_select") {
      selectedServices.set(i.user.id, i.values[0]);

      const services = await getServices();
      const service = services.find((s) => s.id === i.values[0]);

      if (!service) {
        return i.update({
          content: "❌ That service could not be found.",
          embeds: [],
          components: manageRows(),
        });
      }

      return i.update({
        embeds: [
          makeEmbed(
            `📦 ${service.name}`,
            `**Service ID:** \`${service.id}\`\n\n` +
            "Choose an action below.\n\n" +
            "🚀 Deploy • 🔄 Restart • 📈 Status"
          ),
        ],
        components: serviceActionRows(),
      });
    }

    if (i.customId === "tb_monitor") {
      await i.deferReply({ ephemeral: true });

      const services = await getServices();

      const lines = services.map((service) => {
        const instance = service.instances[0];
        const status = instance?.latestDeployment?.status || "No deployment";

        return `📦 **${service.name}** — \`${status}\``;
      });

      return i.editReply({
        embeds: [
          makeEmbed(
            "📊 TB Nodes Monitor",
            lines.join("\n") || "No services found."
          ),
        ],
      });
    }

    if (i.customId === "tb_create") {
      return i.reply({
        embeds: [
          makeEmbed(
            "➕ Create a Railway service",
            "Use this command in a server channel:\n\n" +
            "`!create_vps <service-name>`\n\n" +
            "Then confirm with `!confirm_create`.\n\n" +
            "⚠️ This creates a Railway service record. You must configure its image/source and variables in Railway before it can run a workload."
          ),
        ],
        ephemeral: true,
      });
    }

    if (i.customId === "tb_help") {
      return i.reply({
        embeds: [
          makeEmbed(
            "📚 TB Nodes Commands",
            [
              "`!manage` — Open the control panel",
              "`!services` — List services",
              "`!status <name>` — Show deployment status",
              "`!create_vps <name>` — Prepare service creation",
              "`!confirm_create` — Confirm service creation",
              "`!cancel_create` — Cancel pending creation",
              "`!deploy <name>` — Deploy a service",
              "`!restart <name>` — Restart its latest deployment",
            ].join("\n")
          ),
        ],
        ephemeral: true,
      });
    }

    if (i.customId === "tb_console") {
      const serviceId = selectedServices.get(i.user.id);

      if (!serviceId) {
        return i.reply({
          content: "📦 Select a service first.",
          ephemeral: true,
        });
      }

      const services = await getServices();
      const service = services.find((s) => s.id === serviceId);
      const instance = service?.instances.find(
        (item) => item.environmentId === process.env.RAILWAY_ENVIRONMENT_ID
      ) || service?.instances[0];

      if (!service || !instance?.environmentId) {
        return i.reply({
          content:
            "❌ No environment found. Set RAILWAY_ENVIRONMENT_ID in your bot's environment variables.",
          ephemeral: true,
        });
      }

      return i.reply({
        embeds: [
          makeEmbed(
            "💻 SSH / SSHX Access",
            `**Service:** ${service.name}\n\n` +
            "1. Install the Railway CLI on your own computer.\n" +
            "2. Authenticate with an account authorized for this project.\n" +
            "3. Select the correct project/environment, then run:\n\n" +
            "```bash\nrailway ssh\n```\n\n" +
            "For SSHX, use a supported client inside an authorized terminal. " +
            "The bot does not create SSHX sessions automatically.\n\n" +
            "🔒 Never share API tokens, private keys, or session links in public channels.\n" +
            "⚠️ This is a service container, not a dedicated VPS."
          ),
        ],
        ephemeral: true,
      });
    }

    if (
      [
        "tb_deploy_selected",
        "tb_restart_selected",
        "tb_status_selected",
      ].includes(i.customId)
    ) {
      const serviceId = selectedServices.get(i.user.id);

      if (!serviceId) {
        return i.reply({
          content: "📦 Select a service first.",
          ephemeral: true,
        });
      }

      await i.deferReply({ ephemeral: true });

      const services = await getServices();
      const service = services.find((s) => s.id === serviceId);

      if (!service) {
        return i.editReply("❌ Service not found.");
      }

      const instance = service.instances.find(
        (item) => item.environmentId === process.env.RAILWAY_ENVIRONMENT_ID
      ) || service.instances[0];

      if (!instance?.environmentId) {
        return i.editReply(
          "❌ No environment found for this service."
        );
      }

      if (i.customId === "tb_status_selected") {
        const deployment = instance.latestDeployment;

        return i.editReply({
          embeds: [
            makeEmbed(
              `📈 ${service.name}`,
              `**Status:** ${deployment?.status || "No deployment"}\n` +
              `**Deployment ID:** ${deployment?.id || "N/A"}`
            ),
          ],
        });
      }

      if (i.customId === "tb_deploy_selected") {
        await deployService(service.id, instance.environmentId);
        return i.editReply(`🚀 Deploy requested for **${service.name}**.`);
      }

      if (i.customId === "tb_restart_selected") {
        if (!instance.latestDeployment?.id) {
          return i.editReply("❌ This service has no deployment to restart.");
        }

        await restartService(instance.latestDeployment.id);
        return i.editReply(`🔄 Restart requested for **${service.name}**.`);
      }
    }
  } catch (error) {
    console.error("TB Nodes interaction error:", error);

    const message =
      "❌ Railway request failed. Check the bot logs and Railway API permissions.";

    if (i.deferred || i.replied) {
      return i.editReply({ content: message }).catch(() => {});
    }

    return i.reply({
      content: message,
      ephemeral: true,
    }).catch(() => {});
  }
}

async function handlePrefixMessage(message) {
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = (args.shift() || "").toLowerCase();

  if (command === "manage") {
    if (!isAdmin(message.author.id)) {
      return message.reply("⛔ Only the configured bot administrator can use this panel.");
    }

    const embed = makeEmbed(
      "🚀 TB Nodes Control Hub",
      "Manage Railway services from one panel.\n\n" +
      "📦 Services • 📊 Monitor • ➕ Create\n" +
      "💻 SSH instructions • 🚀 Deploy • 🔄 Restart\n\n" +
      "Select an option below."
    );

    const panel = await message.reply({
      embeds: [embed],
      components: manageRows(),
    });

    const collector = panel.createMessageComponentCollector({
      time: 5 * 60 * 1000,
      filter: (i) => i.user.id === message.author.id,
    });

    collector.on("collect", (i) => {
      handleManageInteraction(i).catch(console.error);
    });

    collector.on("end", () => {
      panel.edit({ components: [] }).catch(() => {});
    });

    return;
  }

  if (command === "commands" || command === "help") {
    return message.reply({
      embeds: [
        makeEmbed(
          "📚 TB Nodes Help",
          "`!manage` — Open the control panel\n" +
          "`!services` — List Railway services\n" +
          "`!status <name>` — Check deployment status\n" +
          "`!create_vps <name>` — Prepare a new service\n" +
          "`!confirm_create` — Confirm service creation\n" +
          "`!cancel_create` — Cancel pending creation\n" +
          "`!deploy <name>` — Deploy a service\n" +
          "`!restart <name>` — Restart a deployment"
        ),
      ],
    });
  }

  if (!isAdmin(message.author.id)) {
    if (
      [
        "services",
        "vps_list",
        "status",
        "create_vps",
        "confirm_create",
        "cancel_create",
        "deploy",
        "restart",
      ].includes(command)
    ) {
      return message.reply("⛔ You are not authorized to manage Railway services.");
    }

    return;
  }

  try {
    if (command === "services" || command === "vps_list") {
      const services = await getServices();

      return message.reply({
        embeds: [
          makeEmbed(
            "📦 Railway Services",
            services.map((s) => `• **${s.name}** — \`${s.id}\``).join("\n") ||
              "No services found."
          ),
        ],
      });
    }

    if (command === "status") {
      const name = args.join(" ").toLowerCase();

      if (!name) return message.reply("Usage: `!status <service-name>`");

      const services = await getServices();
      const service = services.find((s) => s.name.toLowerCase() === name);

      if (!service) return message.reply("❌ Service not found.");

      const instance = service.instances.find(
        (item) => item.environmentId === process.env.RAILWAY_ENVIRONMENT_ID
      ) || service.instances[0];

      const deployment = instance?.latestDeployment;

      return message.reply({
        embeds: [
          makeEmbed(
            `📈 ${service.name}`,
            `**Status:** ${deployment?.status || "No deployment"}\n` +
            `**Deployment:** ${deployment?.id || "N/A"}`
          ),
        ],
      });
    }

    if (command === "create_vps") {
      const name = args.join(" ").trim();

      if (!name || name.length > 60) {
        return message.reply("Usage: `!create_vps <service-name>` (maximum 60 characters).");
      }

      pendingCreates.set(message.author.id, { name });

      return message.reply({
        embeds: [
          makeEmbed(
            "⚠️ Confirm service creation",
            `Create a Railway service named **${name}**?\n\n` +
            "This creates the service record only; configure its image/source in Railway before deploying.\n\n" +
            "Type `!confirm_create` to confirm or `!cancel_create` to cancel."
          ),
        ],
      });
    }

    if (command === "cancel_create") {
      pendingCreates.delete(message.author.id);
      return message.reply("❎ Pending service creation cancelled.");
    }

    if (command === "confirm_create") {
      const pending = pendingCreates.get(message.author.id);

      if (!pending) {
        return message.reply("❌ Nothing to confirm. Use `!create_vps <name>` first.");
      }

      const query = `
        mutation CreateService($input: ServiceCreateInput!) {
          serviceCreate(input: $input) {
            id
            name
          }
        }
      `;

      const data = await railwayRequest(query, {
        input: {
          projectId: process.env.RAILWAY_PROJECT_ID,
          name: pending.name,
        },
      });

      pendingCreates.delete(message.author.id);

      return message.reply({
        embeds: [
          makeEmbed(
            "✅ Railway service created",
            `**Name:** ${data.serviceCreate.name}\n` +
            `**ID:** \`${data.serviceCreate.id}\`\n\n` +
            "Next: configure the service's source/image and variables in the Railway dashboard."
          ),
        ],
      });
    }

    if (command === "deploy" || command === "restart") {
      const name = args.join(" ").toLowerCase();

      if (!name) {
        return message.reply(`Usage: \`!${command} <service-name>\``);
      }

      const services = await getServices();
      const service = services.find((s) => s.name.toLowerCase() === name);

      if (!service) return message.reply("❌ Service not found.");

      const instance = service.instances.find(
        (item) => item.environmentId === process.env.RAILWAY_ENVIRONMENT_ID
      ) || service.instances[0];

      if (!instance?.environmentId) {
        return message.reply("❌ No environment found. Set RAILWAY_ENVIRONMENT_ID.");
      }

      if (command === "deploy") {
        await deployService(service.id, instance.environmentId);
        return message.reply(`🚀 Deploy requested for **${service.name}**.`);
      }

      if (!instance.latestDeployment?.id) {
        return message.reply("❌ No deployment exists to restart.");
      }

      await restartService(instance.latestDeployment.id);
      return message.reply(`🔄 Restart requested for **${service.name}**.`);
    }
  } catch (error) {
    console.error("TB Nodes command error:", error);
    return message.reply(
      "❌ Railway API request failed. Check the Railway token, project ID, permissions, and bot logs."
    );
  }
}

module.exports = {
  handlePrefixMessage,
  handleManageInteraction,
};
