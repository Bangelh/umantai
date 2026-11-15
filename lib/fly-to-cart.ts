'use client';

/**
 * Animación "el producto se va al carrito".
 *
 * Clona la imagen (o un círculo con la inicial) y la desplaza desde el origen
 * hasta el botón del carrito del header. Usa Web Animations API: no agrega
 * dependencias y no bloquea la compra. Si el navegador no la soporta o no hay
 * destino visible, no pasa nada.
 */

const FLY_MS = 620;

function cartTarget(): HTMLElement | null {
  return document.getElementById('cart-target');
}

export function flyToCart(source: HTMLElement | null, imageUrl?: string | null, label?: string): void {
  if (typeof document === 'undefined' || !source) return;
  if (typeof Element.prototype.animate !== 'function') return;

  const target = cartTarget();
  if (!target) return;

  const from = source.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  if (from.width === 0 || to.width === 0) return;

  const size = Math.min(72, Math.max(40, from.width * 0.55));
  const startX = from.left + from.width / 2 - size / 2;
  const startY = from.top + from.height / 2 - size / 2;
  const endX = to.left + to.width / 2 - size / 2;
  const endY = to.top + to.height / 2 - size / 2;

  const node = document.createElement('div');
  node.setAttribute('aria-hidden', 'true');
  node.style.position = 'fixed';
  node.style.left = `${startX}px`;
  node.style.top = `${startY}px`;
  node.style.width = `${size}px`;
  node.style.height = `${size}px`;
  node.style.zIndex = '200';
  node.style.pointerEvents = 'none';
  node.style.borderRadius = '16px';
  node.style.overflow = 'hidden';
  node.style.border = '1px solid var(--um-border-strong)';
  node.style.background = 'var(--um-surface-raised)';
  node.style.boxShadow = '0 12px 30px -12px rgb(0 0 0 / 0.6)';
  node.style.display = 'grid';
  node.style.placeItems = 'center';
  node.style.fontWeight = '600';
  node.style.color = 'var(--um-secondary)';

  if (imageUrl) {
    const image = document.createElement('img');
    image.src = imageUrl;
    image.alt = '';
    image.style.width = '100%';
    image.style.height = '100%';
    image.style.objectFit = 'cover';
    node.appendChild(image);
  } else {
    node.textContent = (label ?? '?').slice(0, 1).toUpperCase();
  }

  document.body.appendChild(node);

  const animation = node.animate(
    [
      { transform: 'translate(0, 0) scale(1)', opacity: 1, offset: 0 },
      {
        transform: `translate(${(endX - startX) * 0.55}px, ${(endY - startY) * 0.25 - 60}px) scale(1.08)`,
        opacity: 1,
        offset: 0.55,
      },
      {
        transform: `translate(${endX - startX}px, ${endY - startY}px) scale(0.25)`,
        opacity: 0.2,
        offset: 1,
      },
    ],
    { duration: FLY_MS, easing: 'cubic-bezier(.2,.8,.2,1)' },
  );

  const bump = () => {
    target.dataset.bump = 'true';
    window.setTimeout(() => {
      delete target.dataset.bump;
    }, 180);
  };

  animation.finished
    .catch(() => undefined)
    .finally(() => {
      node.remove();
      bump();
    });
}
