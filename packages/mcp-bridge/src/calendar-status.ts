import {z} from 'zod';

/** Private diagnostics protocol, never advertised as an agent tool. */
export const CalendarStatusRequestSchema=z.object({method:z.literal('steward/calendarStatus')});
export const CalendarAuthorizationSchema=z.enum(['notDetermined','restricted','denied','writeOnly','fullAccess','unknown']);
export const CalendarStatusResultSchema=z.object({
  appleStore:z.object({readable:z.boolean(),error:z.string().optional()}),
  bridge:z.object({configured:z.boolean(),reachable:z.boolean(),authorization:CalendarAuthorizationSchema.optional(),error:z.string().optional()}),
});
export type CalendarDiagnostics=z.infer<typeof CalendarStatusResultSchema>;
