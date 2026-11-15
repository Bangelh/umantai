import { redirect } from 'next/navigation';

/**
 * /admin/ingresar — alias histórico.
 *
 * La entrada de administración vive ahora en `/admin`: allí se muestra el
 * formulario de correo/contraseña cuando no hay sesión. Este path se conserva
 * para enlaces viejos y redirige a la puerta única.
 */
export default function AdminLoginAliasPage() {
  redirect('/admin');
}
