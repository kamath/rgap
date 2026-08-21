import { rgapRequestSchema } from '@rgap/core'
import { createServerFn } from '@tanstack/react-start'

export const executeRgap = createServerFn({ method: 'POST' })
  .validator(rgapRequestSchema)
  .handler(async ({ data }) => {
    const { executeRgapRequest, rgapErrorResponse } = await import('./execute.server')
    try {
      return await executeRgapRequest(data)
    } catch (error) {
      return rgapErrorResponse(error, data.id)
    }
  })
