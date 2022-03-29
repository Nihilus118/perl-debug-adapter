use strict;
use warnings;
use Data::Dumper;

print "Test";

my $a = 5;

my $b = 9595;

print $a . "\n" . $b . "\n";

foreach (@ARGV) {
    print "$_\n";
}

foreach ( sort keys %ENV ) {
    print "$_ = $ENV{$_}\n";
}

print "AAAAAAAAAAAAAAAHHHHHHHHHHH!";
