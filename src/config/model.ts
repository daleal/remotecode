import * as zod from 'zod';

export const modelSchema = zod
  .string()
  .min(3)
  .transform((model, context) => {
    const separator = model.indexOf('/');
    if (separator < 1 || separator === model.length - 1) {
      context.addIssue({ code: 'custom', message: 'Model must use the provider/model format' });
      return zod.NEVER;
    }

    return {
      providerID: model.slice(0, separator),
      id: model.slice(separator + 1),
    };
  });
