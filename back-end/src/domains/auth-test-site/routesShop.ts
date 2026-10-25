/**
 * Shop routes (only on sites whose scenario has a shop).
 *
 *   GET  /products/:itemId   product page
 *   POST /cart/add | /cart/remove   edit the cookie-keyed cart, 303 /cart
 *   GET  /cart               cart, plus the orders this browser may read
 *   GET  /checkout           signed in or guest cart ? payment form : sign-in gate
 *   POST /checkout/guest     mark this cart as a guest checkout (sites that allow it)
 *   POST /checkout           place the order: 303 /orders/:n | gate | form + error
 *   GET  /orders/:orderNumber  receipt
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { siteUrl } from './service';
import {
  renderCartPage,
  renderCheckoutGatePage,
  renderCheckoutPage,
  renderOrderPage,
  renderProductPage,
} from './servicePagesShop';
import {
  addToCart,
  cartLines,
  cartTotals,
  findItem,
  canViewOrder,
  findOrder,
  isGuestCart,
  markGuestCart,
  ordersFor,
  placeOrder,
  removeFromCart,
  type CartTotals,
} from './serviceShop';
import type { AuthTestSite } from './types';
import {
  cartToken,
  formField,
  sendPage,
  sessionOf,
  setCartCookie,
  setSessionCookie,
  siteOf,
} from './routesShared';

export const shopRouter = Router();

const SHOP_PATHS = ['/:siteId/products', '/:siteId/cart', '/:siteId/checkout', '/:siteId/orders'];

shopRouter.use(SHOP_PATHS, (req: Request, res: Response, next: NextFunction) => {
  const site = siteOf(req);
  if (!site.behavior.shop) {
    res.redirect(303, siteUrl(site));
    return;
  }
  next();
});

/** The cart priced for this shopper: the member price once signed in. */
function totalsFor(req: Request, site: AuthTestSite): CartTotals {
  return cartTotals(site, cartLines(site, cartToken(req)), sessionOf(req).session !== null);
}

const ORDER_ERRORS = {
  empty_cart: 'Your cart is empty.',
  invalid_card: 'Enter the card number, name, expiry and security code.',
  card_declined: 'Your card was declined. Check the card details and try again.',
} as const;

shopRouter.get('/:siteId/products/:itemId', (req: Request, res: Response) => {
  const site = siteOf(req);
  const item = findItem(req.params.itemId);
  if (item === undefined) {
    res.redirect(303, siteUrl(site));
    return;
  }
  const count = cartLines(site, cartToken(req)).reduce((sum, line) => sum + line.quantity, 0);
  sendPage(res, renderProductPage(site, item, sessionOf(req).session, count));
});

shopRouter.post('/:siteId/cart/add', (req: Request, res: Response) => {
  const site = siteOf(req);
  setCartCookie(res, site, addToCart(site, cartToken(req), formField(req, 'item')));
  res.redirect(303, siteUrl(site, '/cart'));
});

shopRouter.post('/:siteId/cart/remove', (req: Request, res: Response) => {
  const site = siteOf(req);
  removeFromCart(site, cartToken(req), formField(req, 'item'));
  res.redirect(303, siteUrl(site, '/cart'));
});

shopRouter.get('/:siteId/cart', (req: Request, res: Response) => {
  const site = siteOf(req);
  const { session } = sessionOf(req);
  const orders = ordersFor(site, { session, cartToken: cartToken(req) });
  sendPage(res, renderCartPage(site, totalsFor(req, site), session, orders));
});

shopRouter.get('/:siteId/checkout', (req: Request, res: Response) => {
  const site = siteOf(req);
  const token = cartToken(req);
  const totals = totalsFor(req, site);
  if (totals.lines.length === 0) {
    res.redirect(303, siteUrl(site, '/cart'));
    return;
  }
  const { session, expired } = sessionOf(req);
  if (session === null && !isGuestCart(site, token)) {
    if (expired) setSessionCookie(res, site, null);
    sendPage(res, renderCheckoutGatePage(site));
    return;
  }
  sendPage(res, renderCheckoutPage(site, totals, { buyer: session?.email ?? null }));
});

shopRouter.post('/:siteId/checkout/guest', (req: Request, res: Response) => {
  const site = siteOf(req);
  const token = cartToken(req);
  if (site.behavior.guest === 'checkout' && token !== null) markGuestCart(site, token);
  res.redirect(303, siteUrl(site, '/checkout'));
});

shopRouter.post(
  '/:siteId/checkout',
  asyncHandler(async (req: Request, res: Response) => {
    const site = siteOf(req);
    const token = cartToken(req);
    const { session } = sessionOf(req);
    const totals = totalsFor(req, site);
    const result = await placeOrder(site, {
      cartToken: token,
      session,
      card: {
        number: formField(req, 'cardNumber'),
        name: formField(req, 'cardName'),
        expiry: formField(req, 'cardExpiry'),
        cvv: formField(req, 'cardCvv'),
        postalCode: formField(req, 'postalCode'),
      },
    });
    if (result.ok) {
      res.redirect(303, siteUrl(site, `/orders/${result.order.orderNumber}`));
      return;
    }
    if (result.reason === 'session_expired') {
      setSessionCookie(res, site, null);
      sendPage(
        res,
        renderCheckoutGatePage(
          site,
          'Your session has expired. Sign in again to finish checking out.'
        )
      );
      return;
    }
    if (result.reason === 'sign_in_required') {
      sendPage(res, renderCheckoutGatePage(site));
      return;
    }
    sendPage(
      res,
      renderCheckoutPage(site, totals, {
        buyer: session?.email ?? null,
        error: ORDER_ERRORS[result.reason],
      })
    );
  })
);

shopRouter.get('/:siteId/orders/:orderNumber', (req: Request, res: Response) => {
  const site = siteOf(req);
  const order = findOrder(site, req.params.orderNumber);
  if (
    order === undefined ||
    !canViewOrder(order, { session: sessionOf(req).session, cartToken: cartToken(req) })
  ) {
    res.redirect(303, siteUrl(site));
    return;
  }
  sendPage(res, renderOrderPage(site, order, cartTotals(site, order.lines, order.email !== null)));
});
