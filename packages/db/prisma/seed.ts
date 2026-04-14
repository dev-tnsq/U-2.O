import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.upsert({
    where: { email: "local@u.app" },
    create: { email: "local@u.app", name: "Local User" },
    update: {}
  });

  const existing = await prisma.card.count({ where: { userId: user.id } });
  if (existing > 0) {
    return;
  }

  const cardA = await prisma.card.create({
    data: {
      userId: user.id,
      title: "Welcome to U",
      sourceType: "note",
      summary: "U stores and connects your knowledge in one context graph.",
      tags: ["intro", "u"],
      notebook: { type: "doc", content: [] }
    }
  });

  const cardB = await prisma.card.create({
    data: {
      userId: user.id,
      title: "MCP-first architecture",
      sourceType: "note",
      summary: "Agents consume context through a unified MCP surface.",
      tags: ["mcp", "architecture"],
      notebook: { type: "doc", content: [] }
    }
  });

  await prisma.connection.create({
    data: {
      fromId: cardA.id,
      toId: cardB.id,
      reason: "manual",
      weight: 1
    }
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
