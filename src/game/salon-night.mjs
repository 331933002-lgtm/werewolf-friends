/**
 * 沙龙之夜板子核心结算逻辑（纯函数，可被 Node.js 直接测试）
 * 包含：觉醒狼美人替死、蚀日侍女吞噬、觉醒预言家查验、奇迹商人反噬、摄梦人保护、胜利条件
 */

/**
 * 计算夜晚死讯
 * @param {Array} actions - 夜晚操作记录 [{stepKey, target, kills, saves, targets}]
 * @param {object} state - {deal, graveyard, prevDreamTarget, wolfBeautyTarget, wolfBeautyUsed, prevWolfBeautyTarget, merchantIsWolf, dayCount}
 * @returns {{deaths: number[], seerResult: string|null, merchantDeath: boolean}}
 */
export function computeSalonNightDeaths(actions, state) {
  const { deal, graveyard = [], prevDreamTarget = null, dayCount = 1 } = state || {};
  const deaths = new Set();
  let seerResult = null;
  let merchantDeath = false;

  const roleOf = (seat) => deal?.find((r) => r.seat === seat);

  // 1. 狼刀（普通狼人 + 蚀日侍女在其他狼人出局后才能刀人）
  const wolfKill = actions.find((a) => a.stepKey === 'werewolf' && a.target != null);
  if (wolfKill && !graveyard.includes(wolfKill.target)) {
    deaths.add(wolfKill.target);
  }

  // 2. 女巫毒药（狼妃封锁反弹：毒被封锁者→反弹给女巫自己）
  const witchAction = actions.find((a) => a.stepKey === 'witch');
  const wolfQueenTarget = actions.find((a) => a.stepKey === 'wolf_queen')?.target ?? null;
  const witchSeat = deal?.find((r) => r.key === 'witch')?.seat;
  if (witchAction?.kills && witchAction.target != null && !graveyard.includes(witchAction.target)) {
    let effectiveTarget = witchAction.target;
    // 狼妃封锁反弹：毒被封锁者→反弹给女巫自己
    if (effectiveTarget === wolfQueenTarget && witchSeat != null) {
      effectiveTarget = witchSeat;
    }
    // 猎魔人免疫毒药
    const demonHunterSeat = deal?.find((r) => r.key === 'demon_hunter')?.seat;
    if (effectiveTarget === demonHunterSeat) {
      effectiveTarget = null;
    }
    if (effectiveTarget != null) {
      deaths.add(effectiveTarget);
    }
  }

  // 3. 女巫救人
  const witchSave = actions.find((a) => a.stepKey === 'witch' && a.saves);
  if (witchSave?.target != null) {
    deaths.delete(witchSave.target);
  }

  // 4. 摄梦人保护（梦游者免疫夜间伤害：狼刀/女巫毒/猎魔人狩猎/觉醒狼美人替死/被查验出局的咒狐）
  const dreamAction = actions.find((a) => a.stepKey === 'dream_weaver');
  const dreamTarget = dreamAction?.target ?? null;
  if (dreamTarget != null) {
    // 剔除梦游者的普通夜间伤害
    deaths.delete(dreamTarget);
  }

  // 5. 觉醒预言家查验（每晚验两人，返回"有狼人"或"无狼人"）
  const seerAction = actions.find((a) => a.stepKey === 'awake_seer');
  if (seerAction?.targets && seerAction.targets.length === 2) {
    const seerSeat = deal?.find((r) => r.key === 'awake_seer')?.seat;
    // 狼妃反弹：查验被封锁者→反弹给自己→金水
    const effectiveTargets = seerAction.targets.map((seat) =>
      seat === wolfQueenTarget ? seerSeat : seat
    );
    const hasWolf = effectiveTargets.some((seat) => roleOf(seat)?.camp === 'wolf');
    seerResult = hasWolf ? '有狼人' : '无狼人';
    // 查验到咒狐 -> 咒狐出局（除非被狼妃反弹，或梦游者保护）
    for (const seat of effectiveTargets) {
      if (roleOf(seat)?.key === 'cursed_fox' && seat !== wolfQueenTarget) {
        // 摄梦人保护：被查验出局的咒狐，如果是梦游者则保护
        if (seat === dreamTarget) continue;
        deaths.add(seat);
      }
    }
  }

  // 6. 魔镜少女查验（查验具体身份，咒狐不出局）
  const mirrorAction = actions.find((a) => a.stepKey === 'mirror_girl');
  // 魔镜少女查验到咒狐不出局，只记录结果

  // 6.5 蚀日侍女吞噬（第二晚开始，吞噬非狼人玩家，获得技能并当晚使用）
  const sunMaidAction = actions.find((a) => a.stepKey === 'sun_maid');
  if (sunMaidAction?.target != null && dayCount >= 2) {
    const sunMaidSeat = deal?.find((r) => r.key === 'sun_maid')?.seat;
    const swallowedTarget = sunMaidAction.target;
    const swallowedRole = roleOf(swallowedTarget);
    // 被吞噬者当晚失去技能（法官手动跳过该角色的行动）
    // 侍女获得该技能并当晚使用（法官手动操作）
    // 记录：侍女吞噬了 swallowedTarget，获得 swallowedRole.key 的技能
    if (swallowedRole && swallowedRole.camp !== 'wolf') {
      // 吞噬好人角色，获得其技能
      // 如果吞噬预言家 → 侍女获得查验技能
      // 如果吞噬女巫 → 侍女获得毒药技能
      // 如果吞噬摄梦人 → 侍女获得梦游技能
    }
  }

  // 7. 猎魔人狩猎（第二晚开始）
  const demonHunterAction = actions.find((a) => a.stepKey === 'demon_hunter');
  if (demonHunterAction?.target != null && dayCount >= 2) {
    const targetRole = roleOf(demonHunterAction.target);
    if (targetRole && targetRole.camp === 'wolf') {
      // 摄梦人保护：梦游者免疫狩猎
      if (demonHunterAction.target !== dreamTarget) {
        deaths.add(demonHunterAction.target);
      }
    } else {
      const demonHunterSeat = deal?.find((r) => r.key === 'demon_hunter')?.seat;
      if (demonHunterSeat && demonHunterSeat !== dreamTarget) {
        deaths.add(demonHunterSeat);
      }
    }
  }

  // 8. 觉醒狼美人替死（首次面临出局时，被魅惑者替代出局）
  // 技能每隔一晚才能发动一次，且全局仅能生效一次
  if (state.wolfBeautyTarget != null && !(state.wolfBeautyUsed ?? false)) {
    const beautySeat = deal?.find((r) => r.key === 'awake_wolf_beauty')?.seat;
    if (beautySeat != null && deaths.has(beautySeat)) {
      // 被魅惑者是梦游者 -> 摄梦保护，替死不生效，狼美人正常出局
      if (state.wolfBeautyTarget === dreamTarget) {
        // 替死不生效，狼美人保持在 deaths 中
      } else {
        // 替死生效：狼美人不出局，被魅惑者替代出局
        deaths.delete(beautySeat);
        deaths.add(state.wolfBeautyTarget);
        state.wolfBeautyUsed = true;
      }
    }
  }

  // 9. 奇迹商人赋予技能（幸运儿获得技能，狼人幸运儿→奇迹商人次日出局）
  const merchantAction = actions.find((a) => a.stepKey === 'miracle_merchant');
  if (merchantAction?.target != null) {
    const luckySeat = merchantAction.target;
    const luckyRole = roleOf(luckySeat);
    // 狼妃反弹：幸运儿技能反弹回奇迹商人自己
    if (luckySeat === wolfQueenTarget) {
      const merchantSeat = deal?.find((r) => r.key === 'miracle_merchant')?.seat;
      if (merchantSeat != null) {
        // 奇迹商人自己成为幸运儿
      }
    }
    // 幸运儿是狼人 → 奇迹商人次日出局
    if (luckyRole && luckyRole.camp === 'wolf') {
      merchantDeath = true;
      deaths.add(deal?.find((r) => r.key === 'miracle_merchant')?.seat);
    }
    // 幸运儿是好人 → 获得技能（法官手动操作）
  }

  // 10. 连续两晚梦游 -> 梦游者出局
  if (dreamTarget != null && prevDreamTarget != null && dreamTarget === prevDreamTarget) {
    deaths.add(dreamTarget);
  }

  // 11. 摄梦人出局 -> 梦游者一并出局
  const dreamerSeat = deal?.find((r) => r.key === 'dream_weaver')?.seat;
  if (dreamerSeat != null && deaths.has(dreamerSeat) && dreamTarget != null && dreamTarget !== dreamerSeat) {
    deaths.add(dreamTarget);
  }

  // 12. 咒狐：被狼刀不出局（被觉醒预言家查验出局已在第5步处理）
  for (const seat of [...deaths]) {
    if (roleOf(seat)?.key === 'cursed_fox' && !seerAction?.targets?.includes(seat)) {
      deaths.delete(seat);
    }
  }

  return {
    deaths: [...deaths].filter((s) => !graveyard.includes(s)).sort((a, b) => a - b),
    seerResult,
    merchantDeath,
  };
}

/**
 * 检查胜利条件
 * @param {Array} deal - 角色分配
 * @param {number[]} graveyard - 已出局座位
 * @returns {string|null} 胜利方
 */
export function checkSalonWin(deal, graveyard) {
  const alive = deal.filter((r) => !graveyard.includes(r.seat));
  const foxAlive = alive.some((r) => r.key === 'cursed_fox');
  const wolvesAlive = alive.filter((r) => r.camp === 'wolf').length;
  const goodAlive = alive.filter((r) => r.camp === 'good').length;

  // 咒狐篡改胜利：只要咒狐存活，好人或狼人都不能赢
  if (foxAlive && (wolvesAlive === 0 || goodAlive === 0)) {
    return 'cursed_fox';
  }

  // 狼人胜利：好人全灭
  if (goodAlive === 0 && !foxAlive) return 'wolf';

  // 好人胜利：狼人全灭
  if (wolvesAlive === 0 && !foxAlive) return 'good';

  return null;
}
