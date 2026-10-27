import { z } from 'zod';

/** Private host/connector protocol; never advertised as an agent tool. */
export const SearchPreparationRequestSchema = z.object({ method:z.literal('steward/prepareSearch') });
export const SearchPreparationResultSchema = z.object({skipped:z.string().optional()});
export function prepareOnce(run:()=>Promise<{skipped?:string}>) {
  let pending:Promise<{skipped?:string}>|undefined;
  return () => pending ??= run().catch(error=>{pending=undefined;throw error;});
}
