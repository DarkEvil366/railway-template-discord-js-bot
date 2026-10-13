
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const PREFIX = "!";
const RAILWAY_API = "https://backboard.railway.com/graphql/v2";
const pendingCreates = new Map();
const selectedServices = new Map();

async function railwayRequest(query, variables = {}) {
  const token = process.env.RAILWAY_TOKEN;
  if (!token) throw new Error("RAILWAY_TOKEN is not configured.");

  const response = await fetch(RAILWAY_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();

  if (!response.ok || result.errors?.length) {
    throw new Error(
      result.errors?.map((e) => e.message).join("; ") ||
        "Railway API request failed."
    );
  }

  return result.data;
}

async function getServices() {
  const projectId = process.env.RAILWAY_PROJECT_ID;
  if (!projectId) throw new Error("RAILWAY_PROJECT_ID is not configured.");

  const data = await railwayRequest(
    `query GetProject($id: String!) {
      project(id: $id) {
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
                    latestDeployment { id status }
                  }
                }
              }
            }
          }
        }
      }
    }`,
    { id: projectId }
  );

  if (!data.project) throw new Error("Railway project not found.");

  return data.project.services.edges.map(({ node }) => ({
    id: node.id,
    name: node.name,
    instances: node.serviceInstances.edges.map(({ node: instance }) => ({
      environmentId: instance.environmentId,
      deploymentId: instance.latestDeployment?.id,
      status: instance.latestDeployment?.status || "NO DEPLOYMENT",
    })),
  }));
}

function isAdmin(userId) {
  return Boolean(
    process.env.ADMIN_USER_ID &&
    userId === process.env.ADMIN_USER_ID
  );
}

function mainEmbed() {
  return new EmbedBuilder()
    .setColor(0x22c55e)
    .setAuthor({ name: "☁️ TB Nodes • Control Center" })
    .setTitle("🎛️ Service Management")
    .setDescription(
      "Welcome to your Railway dashboard!\n\n" +
      "📦 **Services** — list and select services\n" +
      "🚀 **Deployments** — deploy or restart\n" +
      "📊 **Monitoring** — view deployment status\n" +
      "🛠️ **Create Service** — create a Docker-image service\n" +
      "💻 **Console** — supported SSH/SSHX information\n" +
      "⚙️ **Configuration** — configuration options\n\n" +
      "Choose an action below."
    )
    .setFooter({ text: "TB Nodes • Admin Control Panel" })
    .setTimestamp();
}

function mainRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("tb_services")
        .setLabel("Services")
        .setEmoji("📦")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("tb_monitor")
        .setLabel("Monitoring")
        .setEmoji("📊")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("tb_create")
        .setLabel("Create Service")
        .setEmoji("🛠️")
        .setStyle(ButtonStyle.Success)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("tb_deployments")
        .setLabel("Deployments")
        .setEmoji("🚀")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("tb_config")
        .setLabel("Configuration")
        .setEmoji("⚙️")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("tb_console")
        .setLabel("SSH / SSHX")
        .setEmoji("💻")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("tb_close")
        .setLabel("Close")
        .setStyle(ButtonStyle.Danger)
    ),
  ];
}

async function handlePrefixMessage(message) {
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;

  const [rawCommand, ...args] = message.content
    .slice(PREFIX.length).trim().split(/\s+/);

  const command = rawCommand?.toLowerCase();
  if (!command) return;

  if (command === "help" || command === "commands") {
    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x3b82f6)
          .setTitle("☁️ TB Nodes Commands")
          .setDescription(
            "`!manage` — Open the interactive control panel\n" +
            "`!services` — List Railway services\n" +
            "`!status <name>` — Check deployment status\n" +
            "`!deploy <name>` — Trigger deployment\n" +
            "`!restart <name>` — Restart latest deployment\n" +
            "`!create_vps <name> <image>` — Request a service\n" +
            "`!confirm_create` — Confirm service creation\n" +
            "`!cancel_create` — Cancel pending creation\n" +
            "`!ping` — Check bot response"
          )
          .setTimestamp(),
      ],
    });
  }

  if (command === "ping") {
    return message.reply(`🏓 Pong! ${message.client.ws.ping}ms`);
  }

  if (!isAdmin(message.author.id)) {
    return message.reply("🔒 Railway management is restricted to the bot admin.");
  }

  try {
    if (command === "manage") {
      const panel = await message.reply({
        embeds: [mainEmbed()],
        components: mainRows(),
      });

      const collector = panel.createMessageComponentCollector({
        time: 5 * 60 * 1000,
        filter: (i) => i.user.id === message.author.id,
      });

      collector.on("collect", async (i) => {
        try {
          if (!isAdmin(i.user.id)) {
            return i.reply({
              content: "🔒 Admin access required.",
              ephemeral: true,
            });
          }

          if (i.customId === "tb_close") {
            collector.stop();
            return i.update({
              embeds: [
                new EmbedBuilder()
                  .setColor(0x64748b)
                  .setTitle("🔒 TB Nodes Panel Closed")
                  .setDescription("Run `!manage` to reopen."),
              ],
              components: [],
            });
          }

          if (i.customId === "tb_home") {
            return i.update({
              embeds: [mainEmbed()],
              components: mainRows(),
            });
          }

          if (i.customId === "tb_create") {
            const modal = new ModalBuilder()
              .setCustomId("tb_create_modal")
              .setTitle("Create Railway Service")
              .addComponents(
                new ActionRowBuilder().addComponents(
                  new TextInputBuilder()
                    .setCustomId("service_name")
                    .setLabel("Service name")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(40)
                ),
                new ActionRowBuilder().addComponents(
                  new TextInputBuilder()
                    .setCustomId("docker_image")
                    .setLabel("Docker image (e.g. redis:7-alpine)")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                )
              );

            return i.showModal(modal);
          }

          if (i.customId === "tb_services") {
            await i.deferUpdate();
            const services = await getServices();

            const embed = new EmbedBuilder()
              .setColor(0x3b82f6)
              .setTitle("📦 Railway Services")
              .setDescription(
                services.length
                  ? services.map((s) =>
                      `**${s.name}**\n${s.instances.map((x) =>
                        `Status: \`${x.status}\``
                      ).join(" · ") || "No instances"}`
                    ).join("\n\n").slice(0, 4000)
                  : "No services found."
              )
              .setTimestamp();

            const components = [];

            if (services.length) {
              components.push(
                new ActionRowBuilder().addComponents(
                  new StringSelectMenuBuilder()
                    .setCustomId("tb_service_select")
                    .setPlaceholder("Choose a service to manage")
                    .addOptions(
                      services.slice(0, 25).map((s) => ({
                        label: s.name.slice(0, 100),
                        value: s.id,
                        description: `${s.instances.length} instance(s)`,
                      }))
                    )
                )
              );
            }

            components.push(
              new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId("tb_home")
                  .setLabel("Main Menu")
                  .setStyle(ButtonStyle.Secondary)
              )
            );

            return panel.edit({ embeds: [embed], components });
          }

          if (i.customId === "tb_service_select") {
            const serviceId = i.values[0];
            selectedServices.set(i.user.id, serviceId);

            const services = await getServices();
            const service = services.find((s) => s.id === serviceId);

            if (!service) {
              return i.reply({
                content: "Service not found. Refresh the list.",
                ephemeral: true,
              });
            }

            const rows = [
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
                  .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                  .setCustomId("tb_status_selected")
                  .setLabel("Status")
                  .setEmoji("📊")
                  .setStyle(ButtonStyle.Secondary)
              ),
              new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId("tb_home")
                  .setLabel("Main Menu")
                  .setStyle(ButtonStyle.Secondary)
              ),
            ];

            return i.update({
              embeds: [
                new EmbedBuilder()
                  .setColor(0x3b82f6)
                  .setTitle(`📦 ${service.name}`)
                  .setDescription("Select an action for this service.")
                  .addFields({
                    name: "Deployment Status",
                    value: service.instances.map((x) =>
                      `\`${x.status}\``
                    ).join(", ") || "No deployment",
                  })
                  .setTimestamp(),
              ],
              components: rows,
            });
          }

          if (i.customId.startsWith("tb_deploy_selected") ||
              i.customId.startsWith("tb_restart_selected") ||
              i.customId === "tb_status_selected") {
            await i.deferUpdate();

            const serviceId = selectedServices.get(i.user.id);
            if (!serviceId) {
              return panel.edit({
                content: "Select a service first.",
                embeds: [],
                components: mainRows(),
              });
            }

            const service = (await getServices()).find(
              (s) => s.id === serviceId
            );
            if (!service) throw new Error("Service not found.");

            if (i.customId === "tb_status_selected") {
              return panel.edit({
                content: "",
                embeds: [
                  new EmbedBuilder()
                    .setColor(0x3b82f6)
                    .setTitle(`📊 ${service.name} Status`)
                    .setDescription(
                      service.instances.map((x) =>
                        `Environment: \`${x.environmentId}\`\nStatus: **${x.status}**`
                      ).join("\n\n") || "No instances found."
                    )
                    .setTimestamp(),
                ],
                components: [
                  new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                      .setCustomId("tb_home")
                      .setLabel("Main Menu")
                      .setStyle(ButtonStyle.Secondary)
                  ),
                ],
              });
            }

            const environmentId =
              process.env.RAILWAY_ENVIRONMENT_ID;

            const instance = service.instances.find(
              (x) => x.environmentId === environmentId
            );

            if (!instance) {
              throw new Error(
                "No instance for RAILWAY_ENVIRONMENT_ID. Configure the environment ID."
              );
            }

            if (i.customId === "tb_restart_selected") {
              if (!instance.deploymentId) {
                throw new Error("No deployment to restart.");
              }

              await railwayRequest(
                `mutation Restart($id: String!) {
                  deploymentRestart(id: $id)
                }`,
                { id: instance.deploymentId }
              );
            } else {
              await railwayRequest(
                `mutation Deploy($serviceId: String!, $environmentId: String!) {
                  serviceInstanceDeployV2(
                    serviceId: $serviceId,
                    environmentId: $environmentId
                  )
                }`,
                { serviceId: service.id, environmentId }
              );
            }

            return panel.edit({
              content: "",
              embeds: [
                new EmbedBuilder()
                  .setColor(0x22c55e)
                  .setTitle("✅ Action Requested")
                  .setDescription(
                    `${i.customId === "tb_restart_selected" ? "Restart" : "Deployment"} requested for **${service.name}**.`
                  )
                  .setTimestamp(),
              ],
              components: [
                new ActionRowBuilder().addComponents(
                  new ButtonBuilder()
                    .setCustomId("tb_home")
                    .setLabel("Main Menu")
                    .setStyle(ButtonStyle.Secondary)
                ),
              ],
            });
          }

          if (i.customId === "tb_monitor" ||
              i.customId === "tb_deployments") {
            await i.deferUpdate();
            const services = await getServices();

            return panel.edit({
              embeds: [
                new EmbedBuilder()
                  .setColor(0xfacc15)
                  .setTitle("📊 Monitoring & Deployments")
                  .setDescription(
                    services.map((s) =>
                      `**${s.name}** — ${s.instances.map((x) => x.status).join(", ") || "No deployment"}`
                    ).join("\n").slice(0, 4000) || "No services found."
                  )
                  .setTimestamp(),
              ],
              components: [
                new ActionRowBuilder().addComponents(
                  new ButtonBuilder()
                    .setCustomId("tb_services")
                    .setLabel("Manage Services")
                    .setStyle(ButtonStyle.Primary),
                  new ButtonBuilder()
                    .setCustomId("tb_home")
                    .setLabel("Main Menu")
                    .setStyle(ButtonStyle.Secondary)
                ),
              ],
            });
          }

          if (i.customId === "tb_config") {
            return i.reply({
              content:
                "⚙️ Configuration actions need Railway environment-variable and domain API operations to be implemented before they can modify anything. Secrets will not be shown in Discord.",
              ephemeral: true,
            });
          }

          if (i.customId === "tb_console") {
            return i.reply({
              content:
                "💻 Railway does not automatically provide root SSH. Use an authorized Railway shell where supported, or configure SSH/SSHX on a machine you control. Never post private keys or tokens here.",
              ephemeral: true,
            });
          }
        } catch (error) {
          console.error("TB Nodes panel error:", error.message);

          const payload = {
            content: `❌ ${error.message}`.slice(0, 1900),
            ephemeral: true,
          };

          if (i.deferred || i.replied) {
            await i.followUp(payload).catch(() => {});
          } else {
            await i.reply(payload).catch(() => {});
          }
        }
      });

      collector.on("end", () => {
        panel.edit({ components: [] }).catch(() => {});
      });

      return;
    }

    if (command === "services" || command === "vps_list") {
      const services = await getServices();
      return message.reply(
        services.length
          ? services.map((s) => `📦 **${s.name}** — ${s.instances.map((i) => i.status).join(", ")}`).join("\n").slice(0, 1900)
          : "No services found."
      );
    }

    if (command === "status") {
      const name = args.join(" ");
      if (!name) return message.reply("Usage: `!status <service name>`");

      const service = (await getServices()).find(
        (s) => s.name.toLowerCase() === name.toLowerCase()
      );

      if (!service) return message.reply("Service not found.");

      return message.reply(
        `📊 **${service.name}**\n` +
        service.instances.map((i) =>
          `Environment: \`${i.environmentId}\` — **${i.status}**`
        ).join("\n")
      );
    }

    if (command === "create_vps") {
      if (args.length !== 2) {
        return message.reply(
          "Usage: `!create_vps <name> <docker-image>`"
        );
      }

      const [name, image] = args;

      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{1,39}$/.test(name)) {
        return message.reply("Invalid service name.");
      }

      if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(image)) {
        return message.reply("Invalid Docker image.");
      }

      if ((await getServices()).some(
        (s) => s.name.toLowerCase() === name.toLowerCase()
      )) {
        return message.reply("A service with that name already exists.");
      }

      pendingCreates.set(message.author.id, {
        name, image,
        projectId: process.env.RAILWAY_PROJECT_ID,
        createdAt: Date.now(),
      });

      return message.reply(
        `⚠️ **Confirm Service Creation**\nName: **${name}**\nImage: \`${image}\`\n` +
        "Run `!confirm_create` or `!cancel_create`."
      );
    }

    if (command === "confirm_create") {
      const pending = pendingCreates.get(message.author.id);
      if (!pending) return message.reply("No pending creation.");

      if (Date.now() - pending.createdAt > 300000) {
        pendingCreates.delete(message.author.id);
        return message.reply("Confirmation expired. Start again.");
      }

      if ((await getServices()).some(
        (s) => s.name.toLowerCase() === pending.name.toLowerCase()
      )) {
        pendingCreates.delete(message.author.id);
        return message.reply("That service name already exists.");
      }

      const input = {
        projectId: pending.projectId,
        name: pending.name,
        source: { image: pending.image },
      };

      if (process.env.RAILWAY_ENVIRONMENT_ID) {
        input.environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
      }

      const data = await railwayRequest(
        `mutation CreateService($input: ServiceCreateInput!) {
          serviceCreate(input: $input) { id name }
        }`,
        { input }
      );

      pendingCreates.delete(message.author.id);
      const created = data.serviceCreate;

      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x22c55e)
            .setTitle("✅ Service Created")
            .setDescription(
              `**${created.name}**\nID: \`${created.id}\`\n\nVerify deployment in Railway.`
            )
            .setTimestamp(),
        ],
      });
    }

    if (command === "cancel_create") {
      return message.reply(
        pendingCreates.delete(message.author.id)
          ? "🟡 Creation cancelled."
          : "No pending creation."
      );
    }

    if (command === "deploy" || command === "restart") {
      const name = args.join(" ");
      if (!name) return message.reply(`Usage: \`!${command} <service name>\``);

      const service = (await getServices()).find(
        (s) => s.name.toLowerCase() === name.toLowerCase()
      );

      if (!service) return message.reply("Service not found.");

      const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
      const instance = service.instances.find(
        (x) => x.environmentId === environmentId
      );

      if (!instance) return message.reply("Configure RAILWAY_ENVIRONMENT_ID.");

      if (command === "restart") {
        if (!instance.deploymentId) {
          return message.reply("No deployment to restart.");
        }

        await railwayRequest(
          `mutation Restart($id: String!) {
            deploymentRestart(id: $id)
          }`,
          { id: instance.deploymentId }
        );
      } else {
        await railwayRequest(
          `mutation Deploy($serviceId: String!, $environmentId: String!) {
            serviceInstanceDeployV2(
              serviceId: $serviceId,
              environmentId: $environmentId
            )
          }`,
          { serviceId: service.id, environmentId }
        );
      }

      return message.reply(
        `✅ ${command === "restart" ? "Restart" : "Deployment"} requested for **${service.name}**.`
      );
    }

    return message.reply("Unknown command. Use `!commands`.");
  } catch (error) {
    console.error("Railway command failed:", error.message);
    return message.reply(
      `❌ Railway action failed: ${error.message}`.slice(0, 1900)
    );
  }
}

module.exports = { handlePrefixMessage };
