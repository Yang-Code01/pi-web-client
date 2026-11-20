/**
 * 表情面板的数据：分类按 macOS「表情与符号」弹窗的顺序排（笑脸与人物 → 动物与自然 → 食物与饮料 →
 * 活动 → 旅行与地点 → 物品 → 符号 → 旗帜）。
 *
 * 每行一个：`表情 关键词…`。关键词只给搜索框匹配用（中文 + 英文），不是界面文案，所以整段放在
 * i18n-ignore 区间里，不进词典；分类名在 `emoji.ts` 里用的时候才 `tr`。
 */

export interface EmojiGroup {
  /** 分类名（中文原文，使用处再 tr）。 */
  name: string;
  /** 底栏图标：`emoji.ts` 里的 SVG 名。 */
  icon: string;
  rows: string;
}

// i18n-ignore-start 搜索关键词是数据，不是界面文案
const ROWS = {
  smiley: `
😀 笑 开心 grinning smile happy
😃 大笑 开心 smiley happy
😄 笑眼 开心 smile happy
😁 嘻嘻 咧嘴 grin
😆 哈哈 眯眼笑 laughing
😅 汗 尴尬笑 sweat smile
🤣 笑翻 打滚 rofl
😂 笑哭 笑出眼泪 joy tears laugh
🙂 微笑 slight smile
🙃 倒脸 upside down
🫠 融化 melting
😉 眨眼 wink
😊 害羞 微笑 blush
😇 天使 innocent halo
🥰 喜欢 爱心脸 love hearts
😍 花痴 爱 heart eyes love
🤩 崇拜 星星眼 star struck
😘 飞吻 kiss
😗 亲亲 kissing
☺️ 微笑 relaxed
😚 亲亲 闭眼 kissing
😙 亲亲 kissing
🥲 含泪笑 smile tear
😋 好吃 馋 yum
😛 吐舌 tongue
😜 调皮 wink tongue
🤪 疯狂 zany crazy
😝 吐舌 眯眼 tongue
🤑 发财 钱 money
🤗 拥抱 hug
🤭 捂嘴笑 hand over mouth
🫢 惊讶 捂嘴 gasp
🫣 偷看 peek
🤫 嘘 安静 shush
🤔 思考 想 thinking
🫡 敬礼 salute
🤐 闭嘴 zipper
🤨 怀疑 挑眉 raised eyebrow
😐 无语 面无表情 neutral
😑 无表情 expressionless
😶 沉默 无口 no mouth
🫥 虚线脸 dotted
😏 得意 坏笑 smirk
😒 不爽 unamused
🙄 白眼 eye roll
😬 尴尬 grimace
😮‍💨 叹气 呼气 exhale
🤥 说谎 lying
😌 释然 relieved
😔 沮丧 pensive
😪 困 sleepy
🤤 流口水 drool
😴 睡觉 sleeping zzz
😷 口罩 生病 mask
🤒 发烧 生病 thermometer sick
🤕 受伤 bandage hurt
🤢 恶心 nauseated
🤮 呕吐 vomit
🤧 打喷嚏 感冒 sneeze
🥵 热 hot
🥶 冷 cold
🥴 晕 woozy
😵 晕倒 dizzy
😵‍💫 头晕 spiral
🤯 爆炸 震惊 mind blown
🤠 牛仔 cowboy
🥳 庆祝 派对 party
🥸 伪装 disguise
😎 酷 墨镜 cool sunglasses
🤓 书呆子 nerd
🧐 单片眼镜 monocle
😕 困惑 confused
🫤 歪嘴 diagonal mouth
😟 担心 worried
🙁 不开心 frown
☹️ 难过 frowning
😮 惊讶 哦 open mouth surprised
😯 吃惊 hushed
😲 震惊 astonished
😳 脸红 flushed
🥺 可怜 求求 pleading
🥹 感动 holding back tears
😦 惊愕 frowning open
😧 痛苦 anguished
😨 害怕 fearful
😰 焦虑 冷汗 anxious
😥 失望 sad relieved
😢 哭 难过 cry sad
😭 大哭 sob
😱 尖叫 吓 scream
😖 纠结 confounded
😣 坚持 persevere
😞 失望 disappointed
😓 汗 downcast sweat
😩 累 weary
😫 疲倦 tired
🥱 哈欠 yawn
😤 生气 哼 triumph huff
😡 愤怒 pout angry
😠 生气 angry
🤬 骂人 cursing
😈 坏笑 恶魔 devil
👿 恶魔 imp
💀 骷髅 死 skull
☠️ 骷髅 skull crossbones
💩 便便 poop
🤡 小丑 clown
👹 鬼 ogre
👺 天狗 goblin
👻 鬼 ghost
👽 外星人 alien
👾 怪兽 游戏 space invader
🤖 机器人 robot
😺 猫 笑 cat smile
😸 猫 嘻嘻 cat grin
😹 猫 笑哭 cat joy
😻 猫 爱 cat heart eyes
😼 猫 坏笑 cat smirk
😽 猫 亲 cat kiss
🙀 猫 惊恐 cat weary
😿 猫 哭 cat cry
😾 猫 生气 cat pout
🙈 不看 猴 see no evil
🙉 不听 猴 hear no evil
🙊 不说 猴 speak no evil
👋 挥手 你好 再见 wave hello bye
🤚 举手 raised back hand
🖐️ 手掌 hand splayed
✋ 举手 停 raised hand stop
🖖 瓦肯 vulcan
👌 好 OK ok
🤌 捏 pinched
🤏 一点点 pinch
✌️ 耶 胜利 victory peace
🤞 祈祷 好运 crossed fingers luck
🫰 比心 hand heart
🤟 爱你 love you
🤘 摇滚 rock
🤙 打电话 call me
👈 左 left
👉 右 right
👆 上 up
🖕 中指 middle finger
👇 下 down
☝️ 第一 index up
🫵 你 point at you
👍 赞 好 棒 thumbs up like yes
👎 踩 差 thumbs down dislike no
✊ 拳头 fist
👊 拳 出拳 punch
🤛 碰拳 left fist
🤜 碰拳 right fist
👏 鼓掌 clap
🙌 欢呼 raise hands
🫶 比心 heart hands
👐 张开手 open hands
🤲 捧 palms up
🤝 握手 合作 handshake
🙏 拜托 谢谢 祈祷 pray thanks please
✍️ 写字 writing
💅 美甲 nail polish
💪 加油 肌肉 strong muscle
🧠 脑子 brain
👀 看 眼睛 eyes look
👁️ 眼睛 eye
👄 嘴 mouth
👶 宝宝 baby
🧒 小孩 child
👦 男孩 boy
👧 女孩 girl
🧑 人 person
👨 男人 man
👩 女人 woman
🧓 老人 older
👴 爷爷 old man
👵 奶奶 old woman
🙇 鞠躬 抱歉 bow sorry
🤷 摊手 不知道 shrug
🤦 捂脸 无奈 facepalm
🙋 举手 我 raising hand
🙆 好的 OK gesture
🙅 不行 no gesture
💁 请 tipping hand
🧑‍💻 程序员 写代码 technologist coder
👨‍💻 程序员 developer
👩‍💻 程序员 developer
🧑‍🏫 老师 teacher
🧑‍⚕️ 医生 doctor
🧑‍🍳 厨师 cook
🦸 超级英雄 superhero
🥷 忍者 ninja
👮 警察 police
🎅 圣诞老人 santa
🏃 跑 跑步 run
🚶 走路 walk
💃 跳舞 dance
🕺 跳舞 dance
👯 兔女郎 party
🧘 冥想 瑜伽 yoga
🛌 睡觉 bed
👫 情侣 couple
👪 家庭 family
`,
  bear: `
🐶 狗 dog puppy
🐱 猫 cat
🐭 老鼠 mouse
🐹 仓鼠 hamster
🐰 兔子 rabbit
🦊 狐狸 fox
🐻 熊 bear
🐼 熊猫 panda
🐻‍❄️ 北极熊 polar bear
🐨 考拉 koala
🐯 老虎 tiger
🦁 狮子 lion
🐮 牛 cow
🐷 猪 pig
🐽 猪鼻 pig nose
🐸 青蛙 frog
🐵 猴子 monkey
🐔 鸡 chicken
🐧 企鹅 penguin
🐦 鸟 bird
🐤 小鸡 chick
🐣 孵化 hatching
🦆 鸭子 duck
🦅 鹰 eagle
🦉 猫头鹰 owl
🦇 蝙蝠 bat
🐺 狼 wolf
🐗 野猪 boar
🐴 马 horse
🦄 独角兽 unicorn
🐝 蜜蜂 bee
🪲 甲虫 beetle
🐛 虫子 bug
🦋 蝴蝶 butterfly
🐌 蜗牛 snail
🐞 瓢虫 ladybug
🐜 蚂蚁 ant
🕷️ 蜘蛛 spider
🐢 乌龟 turtle
🐍 蛇 snake
🦎 蜥蜴 lizard
🦖 恐龙 霸王龙 t-rex dinosaur
🦕 恐龙 sauropod
🐙 章鱼 octopus
🦑 鱿鱼 squid
🦐 虾 shrimp
🦞 龙虾 lobster
🦀 螃蟹 crab
🐡 河豚 blowfish
🐠 热带鱼 fish
🐟 鱼 fish
🐬 海豚 dolphin
🐳 鲸鱼 whale
🐋 鲸 whale
🦈 鲨鱼 shark
🐊 鳄鱼 crocodile
🐅 老虎 tiger
🐆 豹 leopard
🦓 斑马 zebra
🦍 大猩猩 gorilla
🐘 大象 elephant
🦛 河马 hippo
🦏 犀牛 rhino
🐪 骆驼 camel
🦒 长颈鹿 giraffe
🦘 袋鼠 kangaroo
🐃 水牛 buffalo
🐎 马 horse
🐖 猪 pig
🐑 羊 sheep
🐐 山羊 goat
🦌 鹿 deer
🐕 狗 dog
🐈 猫 cat
🐈‍⬛ 黑猫 black cat
🐓 公鸡 rooster
🦃 火鸡 turkey
🦚 孔雀 peacock
🦜 鹦鹉 parrot
🦢 天鹅 swan
🕊️ 鸽子 和平 dove
🐇 兔 rabbit
🐿️ 松鼠 squirrel
🦔 刺猬 hedgehog
🐾 爪印 paw
🐉 龙 dragon
🐲 龙 dragon face
🌵 仙人掌 cactus
🎄 圣诞树 christmas tree
🌲 松树 evergreen
🌳 树 tree
🌴 椰子树 palm
🌱 发芽 seedling
🌿 草 herb
☘️ 三叶草 shamrock
🍀 四叶草 幸运 clover luck
🎍 门松 bamboo
🍃 叶子 leaves
🍂 落叶 fallen leaf
🍁 枫叶 maple
🍄 蘑菇 mushroom
🌾 稻 rice
💐 花束 bouquet
🌷 郁金香 tulip
🌹 玫瑰 rose
🥀 枯萎 wilted
🌺 芙蓉 hibiscus
🌸 樱花 cherry blossom
🌼 花 blossom
🌻 向日葵 sunflower
🌞 太阳 sun face
🌝 月亮 full moon face
🌛 月亮 moon
🌜 月亮 moon
🌚 新月 new moon face
🌕 满月 full moon
🌙 弯月 crescent moon
🌎 地球 earth
🌏 地球 亚洲 earth asia
🪐 土星 planet
💫 眩晕 dizzy
⭐ 星星 star
🌟 闪亮 glowing star
✨ 闪闪 sparkles
⚡ 闪电 zap lightning
☄️ 彗星 comet
💥 爆炸 boom
🔥 火 热门 fire hot lit
🌪️ 龙卷风 tornado
🌈 彩虹 rainbow
☀️ 晴 太阳 sunny
🌤️ 晴间多云 sun cloud
⛅ 多云 partly cloudy
☁️ 云 cloud
🌧️ 下雨 rain
⛈️ 雷雨 thunder
🌩️ 雷 lightning
❄️ 雪花 snowflake
☃️ 雪人 snowman
⛄ 雪人 snowman
🌬️ 风 wind
💨 风 快 dash
💧 水滴 droplet
💦 汗 水 sweat drops
☔ 雨伞 umbrella rain
🌊 海浪 wave
🌫️ 雾 fog
`,
  cup: `
🍏 青苹果 green apple
🍎 苹果 apple
🍐 梨 pear
🍊 橘子 tangerine orange
🍋 柠檬 lemon
🍌 香蕉 banana
🍉 西瓜 watermelon
🍇 葡萄 grapes
🍓 草莓 strawberry
🫐 蓝莓 blueberries
🍈 哈密瓜 melon
🍒 樱桃 cherries
🍑 桃子 peach
🥭 芒果 mango
🍍 菠萝 pineapple
🥥 椰子 coconut
🥝 猕猴桃 kiwi
🍅 番茄 tomato
🍆 茄子 eggplant
🥑 牛油果 avocado
🥦 西兰花 broccoli
🥬 青菜 leafy green
🥒 黄瓜 cucumber
🌶️ 辣椒 hot pepper
🫑 青椒 bell pepper
🌽 玉米 corn
🥕 胡萝卜 carrot
🧄 大蒜 garlic
🧅 洋葱 onion
🥔 土豆 potato
🍠 红薯 sweet potato
🥐 可颂 croissant
🥯 贝果 bagel
🍞 面包 bread
🥖 法棍 baguette
🥨 椒盐卷饼 pretzel
🧀 奶酪 cheese
🥚 鸡蛋 egg
🍳 煎蛋 cooking
🧈 黄油 butter
🥞 松饼 pancakes
🧇 华夫饼 waffle
🥓 培根 bacon
🥩 牛排 meat
🍗 鸡腿 poultry leg
🍖 肉 meat bone
🌭 热狗 hot dog
🍔 汉堡 hamburger burger
🍟 薯条 fries
🍕 披萨 pizza
🥪 三明治 sandwich
🥙 卷饼 pita
🌮 塔可 taco
🌯 墨西哥卷 burrito
🥗 沙拉 salad
🥘 炖菜 paella
🫕 火锅 fondue
🍝 意面 spaghetti
🍜 面条 拉面 ramen noodles
🍲 火锅 锅 stew pot
🍛 咖喱饭 curry
🍣 寿司 sushi
🍱 便当 bento
🥟 饺子 dumpling
🦪 生蚝 oyster
🍤 天妇罗 炸虾 tempura
🍙 饭团 rice ball
🍚 米饭 rice
🍘 仙贝 rice cracker
🍥 鱼板 fish cake
🥠 幸运饼干 fortune cookie
🥮 月饼 moon cake
🍢 关东煮 串 oden
🍡 团子 dango
🍧 刨冰 shaved ice
🍨 冰淇淋 ice cream
🍦 甜筒 soft ice cream
🥧 派 pie
🧁 纸杯蛋糕 cupcake
🍰 蛋糕 cake
🎂 生日蛋糕 birthday cake
🍮 布丁 pudding
🍭 棒棒糖 lollipop
🍬 糖果 candy
🍫 巧克力 chocolate
🍿 爆米花 popcorn
🍩 甜甜圈 doughnut
🍪 饼干 cookie
🌰 栗子 chestnut
🥜 花生 peanuts
🍯 蜂蜜 honey
🥛 牛奶 milk
☕ 咖啡 coffee
🫖 茶壶 teapot
🍵 茶 tea
🧃 果汁 juice
🥤 饮料 cup straw
🧋 奶茶 珍珠奶茶 bubble tea boba
🍶 清酒 sake
🍺 啤酒 beer
🍻 干杯 cheers beers
🥂 碰杯 clinking glasses
🍷 红酒 wine
🥃 威士忌 whisky
🍸 鸡尾酒 cocktail
🍹 热带饮料 tropical drink
🍾 香槟 champagne
🧊 冰块 ice
🥢 筷子 chopsticks
🍽️ 餐具 plate
🍴 刀叉 fork knife
🥄 勺子 spoon
`,
  ball: `
⚽ 足球 soccer football
🏀 篮球 basketball
🏈 橄榄球 american football
⚾ 棒球 baseball
🥎 垒球 softball
🎾 网球 tennis
🏐 排球 volleyball
🏉 橄榄球 rugby
🥏 飞盘 frisbee
🎱 台球 billiards
🏓 乒乓球 ping pong
🏸 羽毛球 badminton
🏒 冰球 hockey
🥅 球门 goal
⛳ 高尔夫 golf
🏹 射箭 bow arrow
🎣 钓鱼 fishing
🤿 潜水 diving
🥊 拳击 boxing
🥋 武术 martial arts
⛸️ 滑冰 ice skate
🎿 滑雪 ski
🛷 雪橇 sled
🏂 单板滑雪 snowboard
🏋️ 举重 健身 weight lifting gym
🤸 体操 cartwheel
⛹️ 打球 bouncing ball
🤺 击剑 fencing
🏊 游泳 swimming
🚴 骑车 biking
🧗 攀岩 climbing
🏆 奖杯 冠军 trophy winner
🥇 金牌 第一 gold medal first
🥈 银牌 第二 silver medal
🥉 铜牌 第三 bronze medal
🏅 奖牌 medal
🎖️ 勋章 military medal
🎗️ 丝带 reminder ribbon
🎫 票 ticket
🎟️ 入场券 admission tickets
🎪 马戏团 circus
🎭 戏剧 performing arts
🎨 画画 art palette
🎬 电影 拍摄 clapper movie
🎤 麦克风 唱歌 microphone karaoke
🎧 耳机 headphones
🎼 乐谱 score
🎹 钢琴 piano
🥁 鼓 drum
🎷 萨克斯 saxophone
🎺 小号 trumpet
🎸 吉他 guitar
🎻 小提琴 violin
🎲 骰子 dice
♟️ 象棋 chess
🎯 靶子 命中 direct hit target
🎳 保龄球 bowling
🎮 游戏 手柄 video game
🕹️ 摇杆 joystick
🎰 老虎机 slot
🧩 拼图 puzzle
🪁 风筝 kite
🎉 庆祝 撒花 tada party
🎊 彩球 confetti
🎈 气球 balloon
🎁 礼物 gift
🎀 蝴蝶结 ribbon
🧧 红包 red envelope
🎆 烟花 fireworks
🎇 烟火 sparkler
🧨 鞭炮 firecracker
🎃 南瓜 万圣节 jack o lantern halloween
🎐 风铃 wind chime
🎏 鲤鱼旗 carp streamer
🏮 灯笼 lantern
`,
  car: `
🚗 汽车 car
🚕 出租车 taxi
🚙 SUV suv
🚌 公交车 bus
🚎 无轨电车 trolleybus
🏎️ 赛车 racing car
🚓 警车 police car
🚑 救护车 ambulance
🚒 消防车 fire engine
🚐 面包车 minibus
🛻 皮卡 pickup
🚚 货车 truck
🚛 卡车 lorry
🚜 拖拉机 tractor
🛵 电动车 scooter
🏍️ 摩托车 motorcycle
🚲 自行车 bicycle bike
🛴 滑板车 kick scooter
🚨 警灯 siren
🚥 红绿灯 traffic light
🚦 红绿灯 traffic light
🚧 施工 construction
⛽ 加油站 fuel
🚏 公交站 bus stop
🚇 地铁 metro subway
🚄 高铁 high speed train
🚅 新干线 bullet train
🚆 火车 train
🚂 火车头 locomotive
🚊 电车 tram
✈️ 飞机 airplane
🛫 起飞 departure
🛬 降落 arrival
🚀 火箭 上线 rocket launch
🛸 飞碟 ufo
🚁 直升机 helicopter
⛵ 帆船 sailboat
🚤 快艇 speedboat
🛳️ 邮轮 cruise
🚢 轮船 ship
⚓ 锚 anchor
🗺️ 地图 map
🧭 指南针 compass
🗽 自由女神 statue of liberty
🗼 东京塔 tokyo tower
🏰 城堡 castle
🏯 日本城 japanese castle
🏟️ 体育场 stadium
🎡 摩天轮 ferris wheel
🎢 过山车 roller coaster
🎠 旋转木马 carousel
⛲ 喷泉 fountain
🏖️ 海滩 beach
🏝️ 海岛 island
🏜️ 沙漠 desert
⛰️ 山 mountain
🏔️ 雪山 snow mountain
🗻 富士山 fuji
🌋 火山 volcano
🏕️ 露营 camping
⛺ 帐篷 tent
🏠 房子 家 house home
🏡 家 花园 house garden
🏢 办公楼 公司 office building
🏬 商场 department store
🏣 邮局 post office
🏥 医院 hospital
🏦 银行 bank
🏨 酒店 hotel
🏪 便利店 convenience store
🏫 学校 school
🏭 工厂 factory
🏛️ 博物馆 classical building
⛪ 教堂 church
🕌 清真寺 mosque
⛩️ 神社 shrine
🌁 雾 foggy
🌃 夜晚 night stars
🏙️ 城市 cityscape
🌄 日出 山 sunrise mountains
🌅 日出 sunrise
🌆 黄昏 city dusk
🌇 日落 sunset
🌉 夜桥 bridge night
🌌 银河 milky way
🎑 赏月 moon viewing
🗾 日本地图 japan map
`,
  bulb: `
⌚ 手表 watch
📱 手机 mobile phone
💻 电脑 笔记本 laptop computer
⌨️ 键盘 keyboard
🖥️ 显示器 台式机 desktop
🖨️ 打印机 printer
🖱️ 鼠标 mouse
💾 软盘 保存 floppy save
💿 光盘 cd
📷 相机 camera
📸 拍照 camera flash
📹 摄像机 video camera
🎥 摄影机 movie camera
📞 电话 telephone
☎️ 电话 phone
📺 电视 tv
📻 收音机 radio
⏰ 闹钟 alarm clock
⏱️ 秒表 stopwatch
⌛ 沙漏 hourglass
⏳ 沙漏 等待 hourglass waiting
🔋 电池 battery
🔌 插头 plug
💡 灯泡 想法 bulb idea
🔦 手电筒 flashlight
🕯️ 蜡烛 candle
🧯 灭火器 extinguisher
💸 花钱 money wings
💵 美元 dollar
💴 日元 yen
💰 钱袋 money bag
💳 信用卡 credit card
💎 钻石 gem
⚖️ 天平 scale
🧰 工具箱 toolbox
🔧 扳手 wrench
🔨 锤子 hammer
🛠️ 工具 tools
⛏️ 镐 pick
🔩 螺丝 nut bolt
⚙️ 齿轮 设置 gear settings
🧱 砖 brick
⛓️ 链条 chains
🧲 磁铁 magnet
💣 炸弹 bomb
🔪 刀 knife
🛡️ 盾 shield
🔮 水晶球 crystal ball
🧿 护身符 nazar
💈 理发 barber
🔭 望远镜 telescope
🔬 显微镜 microscope
🧪 试管 实验 test tube
🧬 DNA dna
🌡️ 温度计 thermometer
💊 药 pill
💉 打针 syringe
🩹 创可贴 bandage
🧹 扫帚 broom
🧺 篮子 basket
🧻 卫生纸 toilet paper
🚽 马桶 toilet
🛁 浴缸 bathtub
🧼 肥皂 soap
🔑 钥匙 key
🗝️ 旧钥匙 old key
🚪 门 door
🛋️ 沙发 couch
🛏️ 床 bed
🧸 泰迪熊 teddy bear
🛒 购物车 shopping cart
🎁 礼物 gift
✉️ 信封 envelope
📧 邮件 e-mail
📨 来信 incoming envelope
📩 发信 envelope arrow
📤 发件箱 outbox
📥 收件箱 inbox
📦 包裹 快递 package
📮 邮筒 postbox
🏷️ 标签 label
📝 备忘 记录 memo note
📄 文件 文档 page document
📃 文档 page curl
📑 书签页 bookmark tabs
📁 文件夹 folder
📂 打开文件夹 open folder
🗂️ 分类 dividers
📅 日历 calendar
📆 日程 calendar
🗒️ 便签 notepad
📇 卡片 card index
📈 上涨 增长 chart up
📉 下跌 chart down
📊 图表 bar chart
📋 剪贴板 clipboard
📌 图钉 置顶 pushpin
📍 位置 round pushpin
📎 回形针 附件 paperclip
🖇️ 回形针 paperclips
📏 直尺 ruler
📐 三角尺 triangular ruler
✂️ 剪刀 scissors
🗃️ 档案盒 card box
🗄️ 文件柜 file cabinet
🗑️ 垃圾桶 删除 wastebasket trash
🔒 锁 locked
🔓 解锁 unlocked
🔐 加密 locked key
🖊️ 钢笔 pen
✒️ 笔尖 nib
🖌️ 画笔 paintbrush
🖍️ 蜡笔 crayon
✏️ 铅笔 pencil
🔍 搜索 放大镜 search
🔎 搜索 search
📚 书 books
📖 读书 open book
📓 笔记本 notebook
📒 账本 ledger
📕 书 closed book
🔖 书签 bookmark
🔗 链接 link
📰 报纸 newspaper
🔔 铃铛 通知 bell notification
🔕 静音 no bell
📢 喇叭 广播 loudspeaker
📣 喊话 megaphone
💬 对话 消息 speech balloon
💭 想法 thought balloon
🗯️ 怒吼 anger bubble
🎵 音乐 音符 music note
🎶 音乐 notes
`,
  symbols: `
❤️ 红心 爱 red heart love
🧡 橙心 orange heart
💛 黄心 yellow heart
💚 绿心 green heart
💙 蓝心 blue heart
💜 紫心 purple heart
🖤 黑心 black heart
🤍 白心 white heart
🤎 棕心 brown heart
❤️‍🔥 燃烧的心 heart on fire
❤️‍🩹 修复的心 mending heart
💔 心碎 broken heart
❣️ 感叹心 heart exclamation
💕 两颗心 two hearts
💞 旋转的心 revolving hearts
💓 心跳 beating heart
💗 成长的心 growing heart
💖 闪亮的心 sparkling heart
💘 丘比特 heart arrow
💝 爱心礼物 heart ribbon
💟 心形装饰 heart decoration
💯 一百分 满分 hundred
💢 生气 anger
💤 睡觉 zzz
🕳️ 洞 hole
✅ 完成 对 勾 check done
☑️ 勾选 check box
✔️ 对 check mark
❌ 错 叉 cross mark no
❎ 叉 cross button
➕ 加 plus
➖ 减 minus
➗ 除 divide
✖️ 乘 multiply
❓ 问号 疑问 question
❔ 问号 white question
❗ 感叹号 exclamation
❕ 感叹号 white exclamation
‼️ 双感叹 double exclamation
⁉️ 惊问 interrobang
⚠️ 警告 注意 warning
🚫 禁止 prohibited
⛔ 禁止通行 no entry
📛 名牌 name badge
⭕ 圈 对 circle
🔴 红 red circle
🟠 橙 orange circle
🟡 黄 yellow circle
🟢 绿 green circle
🔵 蓝 blue circle
🟣 紫 purple circle
🟤 棕 brown circle
⚫ 黑 black circle
⚪ 白 white circle
🟥 红方块 red square
🟧 橙方块 orange square
🟨 黄方块 yellow square
🟩 绿方块 green square
🟦 蓝方块 blue square
🟪 紫方块 purple square
⬛ 黑方块 black square
⬜ 白方块 white square
🔶 橙菱形 orange diamond
🔷 蓝菱形 blue diamond
🔺 红三角 red triangle
🔻 倒三角 red triangle down
🆗 OK ok button
🆕 新 new
🆒 酷 cool
🆓 免费 free
🆙 上 up
🆘 救命 sos
🔝 置顶 top
🔜 即将 soon
🔙 返回 back
🔛 开 on
🔚 结束 end
⬆️ 上 up arrow
↗️ 右上 up right
➡️ 右 right arrow
↘️ 右下 down right
⬇️ 下 down arrow
↙️ 左下 down left
⬅️ 左 left arrow
↖️ 左上 up left
↕️ 上下 up down
↔️ 左右 left right
↩️ 返回 reply
↪️ 转发 forward
🔄 刷新 循环 refresh
🔁 重复 repeat
🔂 单曲循环 repeat one
▶️ 播放 play
⏸️ 暂停 pause
⏹️ 停止 stop
⏺️ 录制 record
⏭️ 下一个 next
⏮️ 上一个 previous
⏩ 快进 fast forward
⏪ 快退 rewind
🔀 随机 shuffle
🔇 静音 mute
🔈 音量 speaker
🔊 大声 loud
#️⃣ 井号 hash
*️⃣ 星号 asterisk
0️⃣ 零 zero
1️⃣ 一 one
2️⃣ 二 two
3️⃣ 三 three
4️⃣ 四 four
5️⃣ 五 five
6️⃣ 六 six
7️⃣ 七 seven
8️⃣ 八 eight
9️⃣ 九 nine
🔟 十 ten
©️ 版权 copyright
®️ 注册 registered
™️ 商标 trademark
♻️ 回收 recycle
⚛️ 原子 atom
☯️ 阴阳 yin yang
♈ 白羊座 aries
♉ 金牛座 taurus
♊ 双子座 gemini
♋ 巨蟹座 cancer
♌ 狮子座 leo
♍ 处女座 virgo
♎ 天秤座 libra
♏ 天蝎座 scorpio
♐ 射手座 sagittarius
♑ 摩羯座 capricorn
♒ 水瓶座 aquarius
♓ 双鱼座 pisces
🔅 暗 dim
🔆 亮 bright
📶 信号 signal
🛜 无线 wireless wifi
🔰 新手 beginner
💠 花纹 diamond dot
`,
  flag: `
🏁 终点 方格旗 checkered flag finish
🚩 红旗 标记 triangular flag
🎌 交叉旗 crossed flags
🏴 黑旗 black flag
🏳️ 白旗 投降 white flag
🏳️‍🌈 彩虹旗 rainbow flag
🏴‍☠️ 海盗旗 pirate flag
🇨🇳 中国 china cn
🇭🇰 香港 hong kong hk
🇲🇴 澳门 macao mo
🇯🇵 日本 japan jp
🇰🇷 韩国 korea kr
🇸🇬 新加坡 singapore sg
🇲🇾 马来西亚 malaysia my
🇹🇭 泰国 thailand th
🇻🇳 越南 vietnam vn
🇮🇩 印度尼西亚 indonesia id
🇵🇭 菲律宾 philippines ph
🇮🇳 印度 india in
🇦🇺 澳大利亚 australia au
🇳🇿 新西兰 new zealand nz
🇺🇸 美国 united states usa us
🇨🇦 加拿大 canada ca
🇲🇽 墨西哥 mexico mx
🇧🇷 巴西 brazil br
🇦🇷 阿根廷 argentina ar
🇬🇧 英国 united kingdom uk gb
🇫🇷 法国 france fr
🇩🇪 德国 germany de
🇮🇹 意大利 italy it
🇪🇸 西班牙 spain es
🇵🇹 葡萄牙 portugal pt
🇳🇱 荷兰 netherlands nl
🇧🇪 比利时 belgium be
🇨🇭 瑞士 switzerland ch
🇦🇹 奥地利 austria at
🇸🇪 瑞典 sweden se
🇳🇴 挪威 norway no
🇩🇰 丹麦 denmark dk
🇫🇮 芬兰 finland fi
🇮🇪 爱尔兰 ireland ie
🇵🇱 波兰 poland pl
🇬🇷 希腊 greece gr
🇹🇷 土耳其 turkey tr
🇷🇺 俄罗斯 russia ru
🇺🇦 乌克兰 ukraine ua
🇸🇦 沙特阿拉伯 saudi arabia sa
🇦🇪 阿联酋 uae ae
🇮🇱 以色列 israel il
🇪🇬 埃及 egypt eg
🇿🇦 南非 south africa za
🇳🇬 尼日利亚 nigeria ng
🇺🇳 联合国 united nations un
🇪🇺 欧盟 european union eu
`,
};
// i18n-ignore-end

/** 分类名在使用处才 tr（i18n 规矩：模块级常量只放中文原文）。 */
export const EMOJI_GROUPS: EmojiGroup[] = [
  { name: "笑脸与人物", icon: "smiley", rows: ROWS.smiley },
  { name: "动物与自然", icon: "bear", rows: ROWS.bear },
  { name: "食物与饮料", icon: "cup", rows: ROWS.cup },
  { name: "活动", icon: "ball", rows: ROWS.ball },
  { name: "旅行与地点", icon: "car", rows: ROWS.car },
  { name: "物品", icon: "bulb", rows: ROWS.bulb },
  { name: "符号", icon: "symbols", rows: ROWS.symbols },
  { name: "旗帜", icon: "flag", rows: ROWS.flag },
];

export interface EmojiItem {
  e: string;
  /** 小写的关键词串，搜索时 includes 匹配。 */
  k: string;
}

/** 解析成 { e, k } 列表；结果缓存，面板每次打开不用重做。 */
const parsed = new Map<string, EmojiItem[]>();
export function groupItems(g: EmojiGroup): EmojiItem[] {
  let list = parsed.get(g.name);
  if (!list) {
    list = [];
    for (const line of g.rows.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const sp = t.indexOf(" ");
      const e = sp < 0 ? t : t.slice(0, sp);
      list.push({ e, k: (sp < 0 ? "" : t.slice(sp + 1)).toLowerCase() });
    }
    parsed.set(g.name, list);
  }
  return list;
}
