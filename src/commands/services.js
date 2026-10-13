
const { SlashCommandBuilder, MessageFlags } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("services")
    .setDescription("List services in your Railway project"),

  async execute(interaction) {
    if (interaction.user.id !== process.env.ADMIN_USER_ID) {
      return interaction.reply({
        content: "You are not authorized to use this command.",
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    });

    try {
      const token = process.env.RAILWAY_TOKEN;
      const projectId = process.env.RAILWAY_PROJECT_ID;

      if (!token || !projectId) {
        throw new Error("Missing Railway configuration variables.");
      }

      const response = await fetch(
        "https://backboard.railway.com/graphql/v2",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: `
              query project($id: String!) {
                project(id: $id) {
                  name
                  services {
                    edges {
                      node {
                        id
                        name
                      }
                    }
                  }
                }
              }
            `,
            variables: { id: projectId },
          }),
        }
      );

      const result = await response.json();

      if (!response.ok || result.errors?.length) {
        throw new Error("Railway API request failed.");
      }

      const project = result.data?.project;
      if (!project) throw new Error("Project not found.");

      const services = project.services.edges.map(
        ({ node }) => `• ${node.name} — \`${node.id}\``
      );

      await interaction.editReply(
        `**${project.name} — Services**\n${
          services.join("\n") || "No services found."
        }`
      );
    } catch (error) {
      console.error("Services command failed:", error.message);
      await interaction.editReply(
        "Couldn't fetch services. Check your Railway token, project ID, and logs."
      );
    }
  },
};
