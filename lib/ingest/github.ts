export async function fetchRepoStructure(repoUrl: string) {
  // Simulated provider fetch (no local clone).
  await new Promise((resolve) => setTimeout(resolve, 150))
  return {
    provider: 'github' as const,
    repoUrl,
    files: ['README.md', 'src/cart.ts', 'src/order.ts', 'package.json'],
    services: ['cart-service', 'order-service'],
    configs: ['package.json'],
  }
}
