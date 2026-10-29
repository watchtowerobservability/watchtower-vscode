function total(items) {
  return items.reduce((s, i) => s + i.price.amount, 0);
}

module.exports = { total };
