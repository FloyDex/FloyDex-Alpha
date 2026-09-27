// Re-exports the generated Prisma client so other services depend on
// `@kryon/db` (which owns the schema/migrations) rather than reaching into
// `@prisma/client` directly and risking a client generated from a different
// schema.
export * from "@prisma/client";
