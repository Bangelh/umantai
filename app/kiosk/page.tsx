import { redirect } from 'next/navigation';

/**
 * `/kiosk` era una demo del template: pedidos inventados (iPhone, precios en
 * dólares), pasos que no existían y un "reconocimiento de cámara" que no hacía
 * nada. Estaba enlazada desde la barra inferior y el footer como "Kiosco", así
 * que cualquiera podía terminar en una pantalla que no opera nada.
 *
 * El kiosco real es `/admin/kiosco`: la terminal de la operaria, con la clave de
 * dispositivo, la cola de pedidos y la validación del PIN contra el servidor.
 *
 * Se mantiene la ruta como redirección para no romper enlaces guardados.
 */
export default function LegacyKioskPage() {
  redirect('/');
}
