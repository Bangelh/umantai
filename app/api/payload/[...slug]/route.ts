import { REST_DELETE, REST_GET, REST_OPTIONS, REST_PATCH, REST_POST, REST_PUT } from '@payloadcms/next/routes'
import config from '@payload-config'

// The Payload handler for REST API + Admin panel
// This makes Payload available at /api/payload/* and the admin UI at /cms
export const GET = REST_GET(config)
export const POST = REST_POST(config)
export const PUT = REST_PUT(config)
export const PATCH = REST_PATCH(config)
export const DELETE = REST_DELETE(config)
export const OPTIONS = REST_OPTIONS(config)
