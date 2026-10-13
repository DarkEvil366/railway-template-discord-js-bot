
const PREFIX = "!";
const RAILWAY_API = "https://backboard.railway.com/graphql/v2";

// Pending service-creation requests, stored by Discord user ID.
const pendingCreates = new Map();

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
  const projectId = process.env.RAILWAY_PROJECT_ID;

  if (!projectId) {
    throw new Error("RAILWAY_PROJECT_ID is not configured.");
  }

  const data = await railwayRequest(
    `
      query GetProject($id: String!) {
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
    `,
    { id: projectId }
  );

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
    return message.reply(
      [
        "**TB Nodes Commands**",
        "`!commands` — Show commands",
        "`!services` — List Railway services (admin)",
        "`!vps_list` — List services (admin)",
        "`!status <service name>` — Check deployment status (admin)",
        "`!deploy <service name>` — Trigger a deployment (admin)",
        "`!restart <service name>` — Restart the latest deployment (admin)",
        "`!create_vps <name> <docker-image>` — Request a service (admin)",
        "`!confirm_create` — Confirm service creation (admin)",
        "`!cancel_create` — Cancel pending creation (admin)",
        "",
        "Railway services are not traditional VPS machines with root SSH access.",
      ].join("\n")
    );
  }

  const adminId = process.env.ADMIN_USER_ID;

  if (!adminId || message.author.id !== adminId) {
    return message.reply("You are not authorized to use Railway controls.");
  }

  await message.channel.sendTyping();

  try {
    // List Railway services.
    if (command === "services" || command === "vps_list") {
      const services = await getServices();

      if (!services.length) {
        return message.reply("No services were found in the configured project.");
      }

      const lines = services.map((service) => {
        const statuses = service.instances.map(
          (instance) => instance.status
        );

        return `**${service.name}** — ${statuses.join(", ") || "No deployment"}`;
      });

      return message.reply({
        content: `**Railway Services**\n${lines.join("\n")}`.slice(0, 1900),
      });
    }

    // Check deployment status.
    if (command === "status") {
      const name = args.join(" ");

      if (!name) {
        return message.reply("Usage: `!status <service name>`");
      }

      const service = (await getServices()).find(
        (item) => item.name.toLowerCase() === name.toLowerCase()
      );

      if (!service) {
        return message.reply("Service not found. Check `!services`.");
      }

      const lines = service.instances.map(
        (instance) =>
          `Environment: \`${instance.environmentId}\` — Status: **${instance.status}**`
      );

      return message.reply(
        `**${service.name}**\n${lines.join("\n") || "No deployment instances found."}`
      );
    }

    // Request creation of a Railway service from a Docker image.
    if (command === "create_vps") {
      if (args.length !== 2) {
        return message.reply(
          "Usage: `!create_vps <name> <docker-image>`\n" +
            "Example: `!create_vps my-redis redis:7-alpine`"
        );
      }

      const [name, image] = args;

      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{1,39}$/.test(name)) {
        return message.reply(
          "Invalid service name. Use 2–40 letters, numbers, or hyphens."
        );
      }

      if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(image)) {
        return message.reply("Invalid Docker image name.");
      }

      const projectId = process.env.RAILWAY_PROJECT_ID;

      if (!projectId) {
        return message.reply("RAILWAY_PROJECT_ID is not configured.");
      }

      // Avoid creating a duplicate name in the configured project.
      const services = await getServices();

      if (
        services.some(
          (service) => service.name.toLowerCase() === name.toLowerCase()
        )
      ) {
        return message.reply(
          "A service with that name already exists. Choose another name."
        );
      }

      pendingCreates.set(message.author.id, {
        name,
        image,
        projectId,
        createdAt: Date.now(),
      });

      return message.reply(
        `⚠️ **Confirm Railway service creation**\n` +
          `Name: **${name}**\n` +
          `Docker image: \`${image}\`\n\n` +
          `This creates a Railway service, not a traditional VPS. ` +
          `Charges may apply.\n\n` +
          `Confirm with \`!confirm_create\` or cancel with \`!cancel_create\`.`
      );
    }

    // Confirm service creation.
    if (command === "confirm_create") {
      const pending = pendingCreates.get(message.author.id);

      if (!pending) {
        return message.reply(
          "No pending request. Start with `!create_vps <name> <docker-image>`."
        );
      }

      // Expire confirmations after five minutes.
      if (Date.now() - pending.createdAt > 5 * 60 * 1000) {
        pendingCreates.delete(message.author.id);
        return message.reply(
          "That confirmation expired. Please request creation again."
        );
      }

      // Recheck for duplicate names before creating.
      const services = await getServices();

      if (
        services.some(
          (service) =>
            service.name.toLowerCase() === pending.name.toLowerCase()
        )
      ) {
        pendingCreates.delete(message.author.id);

        return message.reply(
          "A service with that name now exists. Please choose another name."
        );
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
        `
          mutation CreateService($input: ServiceCreateInput!) {
            serviceCreate(input: $input) {
              id
              name
            }
          }
        `,
        { input }
      );

      pendingCreates.delete(message.author.id);

      const created = data?.serviceCreate;

      if (!created?.id) {
        throw new Error("Railway did not return the created service details.");
      }

      return message.reply(
        `✅ **Railway service created**\n` +
          `Name: **${created.name}**\n` +
          `ID: \`${created.id}\`\n\n` +
          `Check Railway to verify deployment, configuration, and resource usage.`
      );
    }

    // Cancel a pending creation request.
    if (command === "cancel_create") {
      const existed = pendingCreates.delete(message.author.id);

      return message.reply(
        existed
          ? "Service creation request cancelled."
          : "You have no pending creation request."
      );
    }

    // Deploy or restart an existing service.
    if (command === "deploy" || command === "restart") {
      const name = args.join(" ");

      if (!name) {
        return message.reply(`Usage: \`!${command} <service name>\``);
      }

      const service = (await getServices()).find(
        (item) => item.name.toLowerCase() === name.toLowerCase()
      );

      if (!service) {
        return message.reply("Service not found. Check `!services`.");
      }

      const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;

      const instance = service.instances.find(
        (item) => item.environmentId === environmentId
      );

      if (!instance) {
        return message.reply(
          "No service instance found for RAILWAY_ENVIRONMENT_ID."
        );
      }

      if (command === "restart") {
        if (!instance.deploymentId) {
          return message.reply("This service has no deployment to restart.");
        }

        await railwayRequest(
          `
            mutation RestartDeployment($id: String!) {
              deploymentRestart(id: $id)
            }
          `,
          { id: instance.deploymentId }
        );

        return message.reply(
          `Restart requested for **${service.name}**.`
        );
      }

      await railwayRequest(
        `
          mutation DeployService(
            $serviceId: String!,
            $environmentId: String!
          ) {
            serviceInstanceDeployV2(
              serviceId: $serviceId,
              environmentId: $environmentId
            )
          }
        `,
        {
          serviceId: service.id,
          environmentId: instance.environmentId,
        }
      );

      return message.reply(
        `Deployment requested for **${service.name}**.`
      );
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
