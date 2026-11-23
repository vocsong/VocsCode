import { z } from 'zod';

export const missionImageSchema = z.strictObject({
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']),
  data: z.string().min(1).max(24 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  name: z.string().min(1).max(100_000).refine((value) => !!value.trim() && !value.includes('\0')).optional()
});
