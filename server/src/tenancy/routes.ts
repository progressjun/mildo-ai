/** 테넌시 코어: 워크스페이스 정보 · 내 권한 */
import type { FastifyPluginAsync } from 'fastify';
import { permissionsOf, demoRoleOf } from '../auth/permissions';

export const tenancyRoutes: FastifyPluginAsync = async (app) => {
  app.get('/w/:ws', async (req) => {
    const c = await req.workspace('read');
    const { config, ...w } = c.workspace;
    return { workspace: { ...w, config }, role: c.role, permissions: permissionsOf(c.role), demoRole: demoRoleOf(c.role) };
  });
};
