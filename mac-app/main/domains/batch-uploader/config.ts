/**
 * batch-uploader — config layer
 *
 * Constants, defaults, and env reads for the batch-uploader domain. This
 * domain is a pure pass-through over the Uploader service with no tunable
 * behavior of its own, so the layer is intentionally empty — the file
 * exists to keep the per-domain layer layout uniform with its peers.
 *
 * Layer rule: config may import from own types only.
 */

export {};
