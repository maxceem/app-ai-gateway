// Exact, durable skip decisions for models outside the shipped catalog.
export const notAddedKey = (provider, model) => `${provider}/${model}: not added`;
