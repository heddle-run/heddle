"""Order pricing: line totals, discounts, and the grand total."""


def line_total(price, quantity):
    """Price of one line: unit price times quantity, rounded to cents."""
    return round(price * quantity, 2)


def order_total(lines, discount_percent=0):
    """Total of an order after the discount.

    ``lines`` is a list of ``(price, quantity)`` pairs. ``discount_percent``
    is a percentage, so ``10`` means ten percent off.
    """
    subtotal = sum(line_total(price, quantity) for price, quantity in lines)
    discount = subtotal * discount_percent
    return round(subtotal - discount, 2)
