
const PREFIX = "!";
const RAILWAY_API = "https://backboard.railway.com/graphql/v2";

async function railwayRequest(query, variables = {}) {
  const token = process.env.RAILWAY_TOKEN;

  if (!token) {
    throw new Error("RAILWAY_TOKEN is not configured.");
  }

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
      result.errors?.map((error) => error.message).join("; ") ||
      "Railway API request failed."
    );
  }

  return result.data;
}

async function getServices() {
  const data = await railwayRequest(`
    query {
      project(id: "${process.env.RAILWAY_PROJECT_ID}") {
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
  `);

  if (!data.project) {
    throw new Error("Railway project not found. Check RAILWAY_PROJECT_ID.");
  }

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

async function handlePrefixMessage(message) {
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;

  const [rawCommand, ...args] = message.content
    .slice(PREFIX.length)
    .trim()
    .split(/\s+/);

  const command = rawCommand?.toLowerCase();
  if (!command) return;

  if (command === "commands" || command === "help") {
    return message.reply([
      "**TB Nodes Commands**",
      "`!commands` — Show commands",
      "`!services` — List Railway services (admin)",
      "`!status <service name>` — Check deployment status (admin)",
      "`!deploy <service name>` — Trigger a deployment (admin)",
      "`!restart <service name>` — Restart the latest deployment (admin)",
    ].join("\n"));
  }

  const adminId = process.env.ADMIN_USER_ID;
  if (!adminId || message.author.id !== adminId) {
    return message.reply("You are not authorized to use Railway controls.");
  }

  await message.channel.sendTyping();

  try {
    if (command === "services" || command === "vps_list") {
      const services = await getServices();

      if (!services.length) {
        return message.reply("No services were found in the configured project.");
      }

      const lines = services.map((service) => {
        const statuses = service.instances.map((instance) => instance.status);
        return `**${service.name}** — ${statuses.join(", ") || "No deployment"}`;
      });

      return message.reply({
        content: `**Railway Services**\n${lines.join("\n")}`.slice(0, 1900),
      });
    }

    if (command === "status") {
      const name = args.join(" ");
      if (!name) return message.reply("Usage: `!status <service name>`");

      const service = (await getServices()).find(
        (item) => item.name.toLowerCase() === name.toLowerCase()
      );

      if (!service) return message.reply("Service not found. Check `!services`.");

      return message.reply(
        `**${service.name}**\n` +
        service.instances.map((instance) =>
          `Status: **${instance.status}**`
        ).join("\n")
      );
    }

    if (command === "deploy" || command === "restart") {
      const name = args.join(" ");
      if (!name) {
        return message.reply(`Usage: \`!${command} <service name>\``);
      }

      const service = (await getServices()).find(
        (item) => item.name.toLowerCase() === name.toLowerCase()
      );

      if (!service) return message.reply("Service not found. Check `!services`.");

      const instance = service.instances.find(
        (item) => item.environmentId === process.env.RAILWAY_ENVIRONMENT_ID
      );

      if (!instance) {
        return message.reply(
          "No service instance found in RAILWAY_ENVIRONMENT_ID."
        );
      }

      if (command === "restart") {
        if (!instance.deploymentId) {
          return message.reply("This service has no deployment to restart.");
        }

        await railwayRequest(`
          mutation RestartDeployment($id: String!) {
            deploymentRestart(id: $id)
          }
        `, { id: instance.deploymentId });

        return message.reply(`Restart requested for **${service.name}**.`);
      }

      await railwayRequest(`
        mutation DeployService($serviceId: String!, $environmentId: String!) {
          serviceInstanceDeployV2(
            serviceId: $serviceId,
            environmentId: $environmentId
          )
        }
      `, {
        serviceId: service.id,
        environmentId: instance.environmentId,
      });

      return message.reply(`Deployment requested for **${service.name}**.`);
    }

    return message.reply("Unknown command. Use `!commands`.");
  } catch (error) {
    console.error("Railway command failed:", error.message);
    return message.reply(
      `Railway action failed: ${error.message}`.slice(0, 1900)
    );
  }
}

module.exports = { handlePrefixMessage };
